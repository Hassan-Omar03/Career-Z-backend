const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Master agent rules over real HTTP: the agent recruits for an employer on CareerZ who accepts
// and pays the commission (CareerZ fee first, then the agent's own account); Super Admin sees
// agents and their activity, can pause posting or cancel the licence; AI helpers need a key.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);

let mongo, server, base;
const u = {};
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@agent.test`, passwordHash: 'x', emailVerified: true, roles: [role], phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, subtype, completed: true, percent: 100, fields: { agencyName: `${name} Agency`, country: 'Pakistan' } });
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const is = (r, code, msg) => assert.equal(r.status, code, `${msg} → ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount) => ({ amount, transactionId: `AGT${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'r.png', data: PNG } });
const jobBody = (extra = {}) => ({ title: 'Sales Officer', company: 'Acme Foods', country: 'Pakistan', city: 'Lahore', category: 'sales_marketing', salaryMin: 60000, salaryMax: 80000, currency: 'PKR', description: 'Field sales for an FMCG distributor in Lahore. Graduates welcome; training provided. Visit retailers, take orders and report daily.', status: 'active', ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Admin', 'admin');
  await account('Boss', 'super_admin');
  await account('Agent', 'education_agent', 'individual');
  await account('Employer', 'employer', 'company');
  await account('Student', 'student');
  await model('Setting').create({ key: 'commission_rate_percent', value: 8 });
  await model('Setting').create({ key: 'platform_payment_account', value: { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819' } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

let jobId;
test('the agent names the employer it recruits for; only that verified employer accepts, at the commission rate', async () => {
  is(await api('Agent', 'POST', '/jobs', jobBody({ employerEmail: 'student@agent.test' })), 422, 'not an employer');
  const r = await api('Agent', 'POST', '/jobs', jobBody({ employerEmail: 'employer@agent.test' }));
  is(r, 201, 'job for the employer');
  jobId = r.body.data._id;
  const job = await model('Job').findById(jobId);
  assert.deepEqual([String(job.representedEmployer), job.employerConsent.status, job.employerConsent.ratePercent], [String(u.Employer._id), 'pending', 8]);
  const list = (await api('Employer', 'GET', '/jobs/mine/agent-requests')).body.data;
  assert.equal(list.length, 1);
  is(await api('Student', 'PATCH', `/jobs/${jobId}/agent-request`, { accept: true }), 404, 'someone else');
  is(await api('Employer', 'PATCH', `/jobs/${jobId}/agent-request`, { accept: false }), 422, 'decline needs a reason');
  is(await api('Employer', 'PATCH', `/jobs/${jobId}/agent-request`, { accept: true }), 200, 'accept');
  is(await api('Employer', 'PATCH', `/jobs/${jobId}/agent-request`, { accept: true }), 409, 'once');
});

test('the employer pays the agent commission: CareerZ fee first, then the agent account; admin approves', async () => {
  await model('Setting').create({ key: 'recruitment_platform_fee_percent', value: 10 });
  const c = await model('Commission').create({ agent: u.Agent._id, employer: u.Employer._id, job: jobId, rate: 8, amount: 5000, currency: 'PKR', status: 'pending' });
  is(await api('Employer', 'GET', `/manual-payments/quote/agent_commission/${c._id}`), 409, 'the agent has no account yet');
  await model('User').updateOne({ _id: u.Agent._id }, { $set: { payoutAccount: { method: 'bank_transfer', bankName: 'HBL', accountTitle: 'Agent', accountNumber: 'PK36HABB0000001123456702' } } });
  is(await api('Agent', 'GET', `/manual-payments/quote/agent_commission/${c._id}`), 404, 'only the employer pays');
  const q = (await api('Employer', 'GET', `/manual-payments/quote/agent_commission/${c._id}`)).body.data;
  assert.deepEqual([q.commission, q.sellerAmount, q.seller.account], [500, 5000, null], 'CareerZ 10% on top; agent account hidden until it is confirmed');
  const fee = await api('Employer', 'POST', `/manual-payments/agent_commission/${c._id}`, { commission: leg(500) });
  is(fee, 201, 'CareerZ fee');
  is(await api('Boss', 'PATCH', `/manual-payments/${fee.body.data._id}/decide`, { decision: 'approve' }), 200, 'fee confirmed');
  assert.equal((await api('Employer', 'GET', `/manual-payments/quote/agent_commission/${c._id}`)).body.data.seller.account.accountNumber, 'PK36HABB0000001123456702');
  is(await api('Employer', 'POST', `/manual-payments/agent_commission/${c._id}`, { seller: leg(5000) }), 201, 'agent paid');
  is(await api('Boss', 'PATCH', `/manual-payments/${fee.body.data._id}/decide`, { decision: 'approve' }), 200, 'approved');
  assert.equal((await model('Commission').findById(c._id)).status, 'paid');
  assert.equal((await api('Employer', 'GET', '/jobs/mine/agent-commissions')).body.data[0].status, 'paid');
});

test('Super Admin: agents list and activity; posting ban; licence cancellation', async () => {
  is(await api('Student', 'GET', '/admin/agents'), 403, 'not staff');
  const list = (await api('Admin', 'GET', '/admin/agents')).body.data;
  const row = list.find((a) => a._id === String(u.Agent._id));
  assert.deepEqual([row.company, row.country, row.kind, row.jobs, row.verification], ['Agent Agency', 'Pakistan', 'individual', 1, 'approved']);
  const act = (await api('Admin', 'GET', `/admin/agents/${u.Agent._id}/activity`)).body.data;
  assert.equal(act.jobs.length, 1);
  assert.equal(act.commissions[0].status, 'paid');

  is(await api('Admin', 'PATCH', `/admin/agents/${u.Agent._id}/posting-ban`, { banned: true }), 422, 'reason needed');
  is(await api('Admin', 'PATCH', `/admin/agents/${u.Agent._id}/posting-ban`, { banned: true, days: 7, reason: 'Fake vacancy reported' }), 200, 'ban');
  is(await api('Agent', 'POST', '/jobs', jobBody({ title: 'Another job' })), 403, 'cannot post while banned');
  is(await api('Admin', 'PATCH', `/admin/agents/${u.Agent._id}/posting-ban`, { banned: false }), 200, 'lift');
  is(await api('Agent', 'POST', '/jobs', jobBody({ title: 'Another job' })), 201, 'can post again');

  is(await api('Admin', 'POST', `/admin/agents/${u.Agent._id}/cancel-licence`, { reason: 'x' }), 403, 'only the Super Admin cancels a licence');
  is(await api('Boss', 'POST', `/admin/agents/${u.Agent._id}/cancel-licence`, {}), 422, 'reason needed');
  const cancelled = await api('Boss', 'POST', `/admin/agents/${u.Agent._id}/cancel-licence`, { reason: 'Repeated fraud' });
  is(cancelled, 200, 'cancel');
  assert.equal(cancelled.body.data.closedJobs, 2);
  const agent = await model('User').findById(u.Agent._id);
  assert.equal(agent.roles.includes('education_agent'), false, 'agent role removed');
  assert.equal(agent.status, 'active', 'the account itself stays');
});

test('AI helpers need the person\'s own AI key; complaints can name an agent', async () => {
  const r = await api('Employer', 'POST', '/jobs/ai/improve-description', { title: 'Sales Officer', description: 'Sell things' });
  assert.ok(r.status >= 400 && r.status !== 500 && r.body?.message, `no key gives a clear error, got ${r.status}`);
  is(await api('Employer', 'POST', '/jobs/ai/improve-description', {}), 422, 'title needed');
  const c = await model('Complaint').create({ submittedBy: u.Employer._id, subject: 'Agent took money', description: 'x', category: 'fraud', targetType: 'agent', targetId: u.Agent._id });
  assert.equal(c.targetType, 'agent');
});
