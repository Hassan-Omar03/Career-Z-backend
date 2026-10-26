const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Agent (agreement) jobs: the agent requests an offer → the institute makes the offer and the
// offer letter, which go to the AGENT → the agent forwards them → only then does the candidate see
// them and answer. The agent never makes the offer; the institute never sends it to the candidate.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* file */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@agoffer.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const letter = 'Dear Candidate,\nWe are pleased to offer you the post of Stats Lecturer at City College with the salary below. Welcome aboard.';

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution');
  await account('Agent', 'education_agent', 'agency');
  await model('User').updateOne({ _id: u.Agent._id }, { $set: { payoutAccount: { method: 'bank_transfer', bankName: 'HBL', accountTitle: 'Agent Account', accountNumber: 'PK36HABB0000001123456702' } } });
  await account('Cand', 'student');
  await model('Resume').create({ user: u.Cand._id, skills: ['statistics'], summary: 'Stats graduate' });
  S.inst = await model('Institution').create({ name: 'City College', slug: 'city-college-ao', type: 'college', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const r = await api('Owner', 'POST', '/recruitment/requests', { institution: S.inst._id, agent: u.Agent._id, positions: [{ title: 'Stats Lecturer', category: 'teaching', vacancies: 1 }] });
  await api('Agent', 'POST', `/recruitment/requests/${r.body.data._id}/respond`, { action: 'accept' });
  const ag = await api('Owner', 'POST', `/recruitment/requests/${r.body.data._id}/agreements`, { feeModel: 'fixed_per_hire', fixedAmount: 5000, currency: 'PKR', paymentDueDays: 7 });
  await api('Agent', 'POST', `/recruitment/agreements/${ag.body.data._id}/accept`);
  const j = await api('Agent', 'POST', '/jobs', { agreement: ag.body.data._id, title: 'Stats Lecturer', company: 'x', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 90000, currency: 'PKR', description: 'Teach statistics to BS classes at our Lahore campus. MPhil Statistics and two years of teaching required.' });
  expect(j, 201);
  S.app = (await api('Cand', 'POST', `/jobs/${j.body.data._id}/apply`, {})).body.data._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('the institute sees every applicant and selects who the agent may take forward', async () => {
  const all = (await api('Owner', 'GET', `/recruitment/candidates?institution=${S.inst._id}`)).body.data;
  assert.equal(all.length, 1, 'the institute sees the applicant before any selection');
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/schedule-interview`, { scheduledDate: new Date(Date.now() + 864e5).toISOString(), mode: 'online' }), 409, 'no interview before the institute selects');
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/request-offer`, {}), 409);
  expect(await api('Agent', 'POST', `/recruitment/candidates/${S.app}/select`, {}), 403, 'the agent cannot select');
  expect(await api('Owner', 'POST', `/recruitment/candidates/${S.app}/select`, { note: 'Please interview' }), 200);
  assert.ok(await model('Notification').findOne({ user: u.Agent._id, title: /Selected by the institute: Cand/ }));
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/schedule-interview`, { scheduledDate: new Date(Date.now() + 864e5).toISOString(), mode: 'online' }), 201, 'now the agent interviews');
});

test('the agent cannot make the offer; it requests one from the institute', async () => {
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 90000 }), 403);
  expect(await api('Agent', 'PATCH', `/jobs/applications/${S.app}/status`, { status: 'selected' }), 409, 'no manual Offer stage');
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/request-offer`, { note: 'Strong candidate, did well in the interview.' }), 200);
  assert.ok(await model('Notification').findOne({ user: u.Owner._id, title: /Offer requested: Cand/ }));
  const list = (await api('Owner', 'GET', `/recruitment/candidates?institution=${S.inst._id}`)).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].offerRequest.note, 'Strong candidate, did well in the interview.');
  assert.equal(list[0].agent, 'Agent');
});

test('the institute\'s offer and letter go to the agent; the candidate sees nothing yet', async () => {
  expect(await api('Owner', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 95000, currency: 'PKR', startDate: '2026-12-01' }), 200);
  expect(await api('Owner', 'POST', `/jobs/applications/${S.app}/offer-letter`, { text: letter }), 200, 'letter can go with the offer');
  assert.ok(await model('Notification').findOne({ user: u.Agent._id, title: /Offer from City College/ }));
  assert.equal(await model('Notification').countDocuments({ user: u.Cand._id, title: /offer/i }), 0, 'candidate not told yet');
  assert.equal((await api('Cand', 'GET', '/employment/mine')).body.data.length, 0, 'offer hidden from the candidate');
  const mine = (await api('Cand', 'GET', '/jobs/mine/applications')).body.data[0];
  assert.equal(mine.employment, null);
  const emp = await model('Employment').findOne({ application: S.app });
  expect(await api('Cand', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted' }), 409, 'cannot accept before it reaches them');
  const agentView = (await api('Agent', 'GET', `/jobs/${mine.job._id}/applicants`)).body.data[0];
  assert.equal(agentView.employment.salary, 95000, 'the agent sees the offer');
});

test('the agent forwards; the candidate then sees and accepts; the institute is told', async () => {
  const f = await api('Agent', 'POST', `/jobs/applications/${S.app}/forward-offer`);
  expect(f, 200);
  assert.match(f.body.message, /offer and offer letter/);
  expect(await api('Agent', 'POST', `/jobs/applications/${S.app}/forward-offer`), 409, 'nothing left to forward');
  const [emp] = (await api('Cand', 'GET', '/employment/mine')).body.data;
  assert.equal(emp.salary, 95000);
  assert.match(emp.offerLetter.text, /pleased to offer/);
  assert.equal((await model('JobApplication').findById(S.app)).status, 'selected');
  expect(await api('Cand', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted' }), 200);
  assert.ok(await model('Notification').findOne({ user: u.Owner._id, title: /Offer accepted: Cand/ }), 'institute told');
  assert.ok(await model('Notification').findOne({ user: u.Agent._id, title: /Offer accepted: Cand/ }), 'agent told');
  // Then joining: agent marks joined, the institute confirms (existing flow).
  expect(await api('Agent', 'PATCH', `/jobs/applications/${S.app}/status`, { status: 'hired' }), 200);
  const c = await api('Owner', 'POST', `/recruitment/hires/${S.app}/confirm`, {});
  expect(c, 200);
  assert.equal(c.body.data.invoice.grossFee, 5000);
});

test('the institute can also select straight from the CV, without an interview', async () => {
  await account('Cand2', 'student');
  const job = (await model('Job').findOne({ title: 'Stats Lecturer' })).toObject();
  await model('Job').updateOne({ _id: job._id }, { $set: { status: 'active' } });
  const a = await api('Cand2', 'POST', `/jobs/${job._id}/apply`, {});
  expect(a, 201);
  expect(await api('Owner', 'POST', `/recruitment/candidates/${a.body.data._id}/select`, { decision: 'direct' }), 200);
  const app = await model('JobApplication').findById(a.body.data._id);
  assert.equal(app.institutionSelection.direct, true);
  assert.ok(await model('Notification').findOne({ user: u.Agent._id, title: /Selected by the institute: Cand2/, body: /No interview needed/ }));
  expect(await api('Owner', 'POST', `/jobs/applications/${a.body.data._id}/offer`, { salary: 90000 }), 200, 'offer straight away');
});

test('wallet payment: institute pays from its wallet, agent and CareerZ are paid at once, no admin step', async () => {
  await account('Admin', 'super_admin');
  const Wallet = model('Wallet');
  const bal = async (who) => (await Wallet.findOne({ user: u[who]._id, currency: 'PKR' }))?.available || 0;
  const inv = await model('RecruitmentInvoice').findOne({});
  expect(await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 422, 'empty wallet');
  await Wallet.create({ user: u.Owner._id, currency: 'PKR', available: 10000 });
  const detail = (await api('Owner', 'GET', `/recruitment/invoices/${inv._id}`)).body.data;
  assert.equal(detail.walletBalance, 10000);
  expect(await api('Agent', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 403, 'only the institute pays');
  expect(await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 200);
  assert.equal(await bal('Owner'), 5000, 'paid from the institute wallet');
  assert.equal((await model('RecruitmentInvoice').findById(inv._id)).status, 'paid', 'settled at once');
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${inv._id}/verify`, { decision: 'approve' }), 409, 'nothing for the admin to approve');
  expect(await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 409, 'cannot pay twice');
  assert.equal(await bal('Owner'), 5000);
  assert.equal(await bal('Agent'), inv.agentEarning, "agent's share straight into the agent wallet");
  assert.equal((await model('Commission').findById(inv.commission)).status, 'paid', 'no second payout');
  const tx = await model('WalletTransaction').find({ reference: (await model('RecruitmentInvoice').findById(inv._id)).wallet.reference }).lean();
  assert.ok(tx.some((t) => String(t.user) === String(u.Owner._id) && t.status === 'completed'));
  assert.ok(tx.some((t) => String(t.user) === String(u.Agent._id) && t.type === 'transfer_in'));
});
