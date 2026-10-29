const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Employer promotions and packages (master 12.18, prices by Super Admin 12.20), paid by bank
// transfer through the manual payment engine; and the employer analytics (12.19) and dashboard (12.1).
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const ai = require('../src/services/ai.service');
let aiReply = '[]';
mock.method(ai, 'generate', async () => aiReply);
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@emppkg.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount) => ({ amount, transactionId: `TXN${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'receipt.png', data: PNG } });
const jobBody = (extra = {}) => ({ title: 'Physics Teacher', company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', skills: ['physics'], description: 'Teach physics to matric and FSc classes at our Lahore campus. M.Sc Physics required.', ...extra });

async function buy(who, key, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const q = await api(who, 'GET', `/manual-payments/quote/employer_package/${key}${qs ? `?${qs}` : ''}`);
  expect(q, 200, `quote ${key}`);
  const r = await api(who, 'POST', `/manual-payments/employer_package/${key}`, { ...query, phone: '03001234567', commission: leg(q.body.data.commission) });
  expect(r, 201, `submit ${key}`);
  expect(await api('Boss', 'PATCH', `/manual-payments/${r.body.data._id}/decide`, { decision: 'approve' }), 200, `approve ${key}`);
  return q.body.data;
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Cand', 'student');
  await account('Cand2', 'student');
  await account('Boss', 'super_admin');
  await account('Pay', 'teacher');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  expect(await api('Boss', 'PUT', '/manual-payments/platform-account', { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819', qr: PNG }), 200);
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('Super Admin sets package prices, tax and the free live-job limit', async () => {
  const pub = await api(null, 'GET', '/employer-packages');
  assert.equal(pub.body.data.packages.sponsored.price, 1500);
  expect(await api('Employer', 'PATCH', '/employer-packages/admin/config', { taxPercent: 5 }), 403);
  expect(await api('Boss', 'PATCH', '/employer-packages/admin/config', { taxPercent: 80 }), 422);
  const r = await api('Boss', 'PATCH', '/employer-packages/admin/config', { taxPercent: 10, freeActiveJobs: 1, packages: { sponsored: { price: 2000, days: 10 }, subscription: { jobLimit: 3 } } });
  expect(r, 200);
  assert.equal(r.body.data.packages.sponsored.price, 2000);
  assert.equal(r.body.data.packages.subscription.jobLimit, 3);
});

test('packages: job limit, subscription, sponsored + urgent promotions, top hiring, hiring credits, premium CSV, invoices with tax', async () => {
  const j1 = await api('Employer', 'POST', '/jobs', jobBody());
  expect(j1, 201);
  S.job = j1.body.data._id;
  expect(await api('Employer', 'POST', '/jobs', jobBody({ title: 'Chemistry Teacher' })), 403, 'free limit is 1 live job');
  const draft = await api('Employer', 'POST', '/jobs', jobBody({ title: 'Chemistry Teacher', status: 'draft' }));
  expect(draft, 201, 'drafts are fine');

  // Subscription raises the limit to 3.
  const sub = await buy('Employer', 'subscription');
  assert.equal(sub.commission, 5500, 'price plus 10% tax');
  expect(await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { status: 'active' }), 200, 'second live job allowed now');

  // Sponsored + urgent on a job: sorted above and badged in public search.
  expect(await api('Employer', 'GET', '/manual-payments/quote/employer_package/sponsored'), 422, 'per-job package needs a job');
  await buy('Employer', 'sponsored', { job: draft.body.data._id });
  await buy('Employer', 'urgent', { job: draft.body.data._id });
  await buy('Employer', 'top_hiring');
  const list = await api(null, 'GET', '/public/jobs');
  const first = list.body.data.items[0];
  assert.equal(first._id, draft.body.data._id, 'sponsored job first');
  assert.equal(first.sponsored, true);
  assert.equal(first.urgent, true);
  assert.equal(first.topHiring, true);

  // Hiring package credits feature a job without paying again.
  expect(await api('Employer', 'POST', `/employer-packages/featured-credit/${S.job}`), 409, 'no credits yet');
  await buy('Employer', 'hiring_package');
  const used = await api('Employer', 'POST', `/employer-packages/featured-credit/${S.job}`);
  expect(used, 200);
  assert.equal(used.body.data.creditsLeft, 4);
  assert.equal((await model('Job').findById(S.job).lean()).featured, true);

  // Premium tools: applicant CSV.
  await api('Cand', 'POST', `/jobs/${S.job}/apply`, {});
  expect(await api('Employer', 'GET', `/employer-packages/jobs/${S.job}/applicants.csv`), 402, 'premium needed');
  await buy('Employer', 'premium_tools');
  const csv = await api('Employer', 'GET', `/employer-packages/jobs/${S.job}/applicants.csv`);
  expect(csv, 200);
  assert.match(csv.text, /"Name","Email"/);
  assert.match(csv.text, /cand@emppkg\.test/);
  expect(await api('Cand', 'GET', `/employer-packages/jobs/${S.job}/applicants.csv`), 404);

  // Invoices with the tax split; a finance staff member can see and buy for the company.
  const mine = await api('Employer', 'GET', '/employer-packages/mine');
  assert.equal(mine.body.data.purchases.length, 6);
  assert.equal(mine.body.data.perks.featuredCredits, 4);
  assert.equal(mine.body.data.jobLimit, 3);
  const inv = mine.body.data.purchases.find((p) => p.package === 'subscription');
  assert.equal(inv.baseAmount, 5000);
  assert.equal(inv.taxAmount, 500);
  expect(await api('Employer', 'GET', `/employer-packages/invoices/${inv._id}`), 200);
  expect(await api('Pay', 'GET', `/employer-packages/invoices/${inv._id}`), 404, 'not staff yet');
  const staff = await api('Employer', 'POST', '/employer-staff', { email: 'pay@emppkg.test', role: 'finance' });
  expect(await api('Pay', 'PATCH', `/employer-staff/mine/${staff.body.data._id}/respond`, { decision: 'accepted' }), 200);
  expect(await api('Pay', 'GET', `/employer-packages/invoices/${inv._id}`), 200);
  expect(await api('Pay', 'GET', `/employer-packages/mine?employer=${u.Employer._id}`), 200);
  await buy('Pay', 'top_hiring', { employer: String(u.Employer._id) });
  const sales = await api('Boss', 'GET', '/employer-packages/admin/sales');
  assert.ok(sales.body.data.byPackage.find((p) => p._id === 'top_hiring').count === 2);
});

test('analytics: views, applied, qualified, hiring time, cost per hire, AI match accuracy; full dashboard', async () => {
  await api(null, 'GET', `/public/jobs/${S.job}`);
  await api('Cand2', 'GET', `/jobs/${S.job}`);
  await api('Employer', 'GET', `/jobs/${S.job}`);
  const a2 = await api('Cand2', 'POST', `/jobs/${S.job}/apply`, {});
  const apps = await model('JobApplication').find({ job: S.job }).sort({ createdAt: 1 });
  aiReply = '[{"n":1,"score":85,"reason":"Physics teacher"},{"n":2,"score":30,"reason":"No physics"}]';
  expect(await api('Employer', 'POST', `/jobs/${S.job}/ai/rank-applicants`), 200);
  expect(await api('Employer', 'PATCH', `/jobs/applications/${apps[0]._id}/status`, { status: 'shortlisted' }), 200);
  expect(await api('Employer', 'PATCH', `/jobs/applications/${a2.body.data._id}/status`, { status: 'rejected' }), 200);
  const r = await api('Employer', 'GET', '/jobs/mine/analytics');
  expect(r, 200);
  const t = r.body.data.totals;
  assert.equal(t.views, 2, 'the poster\'s own view is not counted');
  assert.equal(t.applied, 2);
  assert.equal(t.qualified, 1);
  assert.equal(t.aiMatchAccuracy, 100);
  assert.equal(t.aiJudged, 2);
  assert.ok(t.spendPKR > 0);
  assert.equal(t.costPerHirePKR, null, 'no hires yet');
  const row = r.body.data.jobs.find((j) => j._id === S.job);
  assert.equal(row.conversion, 100);

  const d = await api('Employer', 'GET', '/jobs/mine/employer-dashboard');
  expect(d, 200);
  assert.equal(d.body.data.activeJobs, 2);
  assert.equal(d.body.data.applications, 2);
  assert.equal(d.body.data.shortlisted, 1);
  assert.equal(d.body.data.verification, 'approved');
  assert.ok(d.body.data.trustScore > 0);
  expect(await api('Pay', 'GET', `/jobs/mine/analytics?employer=${u.Employer._id}`), 200, 'finance staff see reports');
  expect(await api('Cand', 'GET', '/jobs/mine/analytics'), 403);
});

test('salary management: payslips with allowances, bonus, deductions, leave and attendance; employee confirms; on-time salary trust', async () => {
  const appRow = await model('JobApplication').findOne({ job: S.job, applicant: u.Cand._id });
  const employment = await model('Employment').create({ application: appRow._id, job: S.job, employer: u.Employer._id, employee: u.Cand._id, status: 'active', salary: 60000, currency: 'PKR', startDate: new Date(Date.now() - 90 * 864e5) });
  const list = await api('Employer', 'GET', '/employer-payroll?month=2026-09');
  expect(list, 200);
  assert.equal(list.body.data.employees.length, 1);
  expect(await api('Employer', 'POST', '/employer-payroll', { employment: employment._id, month: '2026-9' }), 422, 'month format');
  expect(await api('Employer', 'POST', '/employer-payroll', { employment: employment._id, month: '2026-09', workingDays: 22, presentDays: 20, leaveDays: 2, absentDays: 3 }), 422, 'days add up');
  const slip = await api('Employer', 'POST', '/employer-payroll', { employment: employment._id, month: '2026-09', basic: 60000, allowances: [{ label: 'Transport', amount: 5000 }], bonus: 2000, deductions: [{ label: 'Income tax', amount: 3000 }, { label: 'Absent day', amount: 2000 }], workingDays: 22, presentDays: 19, leaveDays: 2, absentDays: 1 });
  expect(slip, 200);
  assert.equal(slip.body.data.gross, 67000);
  assert.equal(slip.body.data.net, 62000);
  expect(await api('Cand', 'POST', '/employer-payroll', { employment: employment._id, month: '2026-09', basic: 1 }), 403, 'only the employer');
  expect(await api('Cand', 'GET', '/employer-payroll/mine'), 200);
  assert.equal((await api('Cand', 'GET', '/employer-payroll/mine')).body.data.length, 0, 'drafts are private');
  const id = slip.body.data._id;
  expect(await api('Employer', 'POST', `/employer-payroll/${id}/paid`, {}), 409, 'issue first');
  expect(await api('Employer', 'POST', `/employer-payroll/${id}/issue`, {}), 200);
  expect(await api('Employer', 'POST', '/employer-payroll', { employment: employment._id, month: '2026-09', basic: 1 }), 409, 'issued slips are locked');
  expect(await api('Pay', 'POST', `/employer-payroll/${id}/paid`, { employer: String(u.Employer._id), paidOn: '2026-10-05', reference: 'IBFT 1234' }), 200, 'finance staff marks paid');
  expect(await api('Cand', 'PATCH', `/employer-payroll/mine/${id}/confirm`, { received: true }), 200);
  const trust = (await api(null, 'GET', `/employer-trust/companies/${u.Employer._id}`)).body.data.trust;
  const f = trust.factors.find((x) => x.key === 'onTimeSalary');
  assert.equal(f.hasData, true);
  assert.equal(f.points, 15, 'paid by the 10th and confirmed');
});
