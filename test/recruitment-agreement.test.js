const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Institute–Agent recruitment: Find Agents → request → agent accepts → agreement versions accepted
// by both sides → the agent publishes under the agreement → only the institute confirms joining →
// fee from the agreement (no hardcoded rate) and 0% platform fee by default → invoice → payment
// proof → admin verifies → agent earning available; replacement/refund only by admin decision.
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
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '', approved = true) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@recruit.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100, fields: role === 'education_agent' ? { agencyName: `${name} Recruiters` } : {} });
}
const terms = (extra = {}) => ({ feeModel: 'percentage', percentage: 50, salaryBase: 'monthly_salary', currency: 'PKR', paymentDueDays: 14, replacement: { periodDays: 60, deadlineDays: 15, attempts: 1 }, ...extra });
const job = (extra = {}) => ({ title: 'Physics Lecturer', company: 'ignored', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 80000, salaryMax: 100000, currency: 'PKR',
  description: 'Teach physics to intermediate classes at our Lahore campus. M.Sc Physics and two years of teaching required.', ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution');
  await account('Agent', 'education_agent', 'agency');
  await account('Pending', 'education_agent', 'individual', false);
  await account('Other', 'education_agent', 'individual');
  await account('Cand', 'student');
  await account('Admin', 'super_admin');
  await model('Resume').create({ user: u.Cand._id, skills: ['physics'] });
  S.inst = await model('Institution').create({ name: 'Punjab College', slug: 'punjab-college', type: 'college', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('agents directory lists only verified agents, with their profile and filters', async () => {
  expect(await api('Agent', 'PUT', '/recruitment/agent-profile', { specialties: ['teaching'], serviceCities: 'Lahore, Faisalabad', experienceYears: 6, bio: 'Teacher hiring' }), 200);
  expect(await api('Agent', 'PUT', '/recruitment/agent-profile', { specialties: ['astrology'] }), 422);
  expect(await api('Owner', 'PUT', '/recruitment/agent-profile', { specialties: [] }), 403);
  const all = (await api('Owner', 'GET', '/recruitment/agents')).body.data;
  assert.deepEqual(all.map((a) => a.person).sort(), ['Agent', 'Other']);
  const teaching = (await api('Owner', 'GET', '/recruitment/agents?category=teaching&city=faisalabad')).body.data;
  assert.equal(teaching.length, 1);
  assert.equal(teaching[0].name, 'Agent Recruiters');
  assert.equal(teaching[0].agency, true);
});

test('institute sends a request; only a verified agent can receive it; the agent answers', async () => {
  const body = { institution: S.inst._id, agent: u.Agent._id, positions: [{ title: 'Physics Lecturer', category: 'teaching', vacancies: 2, salaryMin: 80000 }], hiringDeadline: '2026-12-31', proposedFee: '50% of first salary' };
  expect(await api('Owner', 'POST', '/recruitment/requests', { ...body, agent: u.Pending._id }), 403, 'unverified agent');
  expect(await api('Cand', 'POST', '/recruitment/requests', body), 403, 'not institute staff');
  expect(await api('Owner', 'POST', '/recruitment/requests', { ...body, positions: [{ title: 'X', vacancies: 0 }] }), 422);
  const r = await api('Owner', 'POST', '/recruitment/requests', body);
  expect(r, 201);
  S.req = r.body.data._id;
  assert.equal((await model('Notification').countDocuments({ user: u.Agent._id, category: 'recruitment' })), 1);
  expect(await api('Other', 'POST', `/recruitment/requests/${S.req}/respond`, { action: 'accept' }), 403, 'another agent');
  expect(await api('Owner', 'POST', `/recruitment/requests/${S.req}/respond`, { action: 'accept' }), 403, 'institute cannot answer for the agent');
  expect(await api('Agent', 'POST', `/recruitment/requests/${S.req}/respond`, { action: 'clarify' }), 422, 'question needs text');
  expect(await api('Agent', 'POST', `/recruitment/requests/${S.req}/respond`, { action: 'clarify', message: 'Is housing provided?' }), 200);
  expect(await api('Owner', 'POST', `/recruitment/requests/${S.req}/messages`, { text: 'Yes, on campus.' }), 200);
  expect(await api('Agent', 'POST', `/recruitment/requests/${S.req}/respond`, { action: 'accept' }), 200);
  assert.equal((await model('RecruitmentRequest').findById(S.req)).status, 'accepted');
  assert.equal((await api('Agent', 'GET', '/recruitment/requests')).body.data.length, 1);
  assert.equal((await api('Owner', 'GET', `/recruitment/requests?institution=${S.inst._id}`)).body.data[0].messages.length, 2);
});

test('agreement needs both sides; the agent can publish only under an active agreement', async () => {
  expect(await api('Agent', 'POST', '/jobs', job({ institution: S.inst._id })), 403, 'agent cannot post for an institute directly');
  expect(await api('Owner', 'POST', `/recruitment/requests/${S.req}/agreements`, terms({ salaryBase: '' })), 422, 'salary base required');
  expect(await api('Owner', 'POST', `/recruitment/requests/${S.req}/agreements`, terms({ replacement: { periodDays: 60 } })), 422, 'replacement needs a deadline');
  const v1 = await api('Owner', 'POST', `/recruitment/requests/${S.req}/agreements`, terms({ percentage: 40 }));
  expect(v1, 201);
  expect(await api('Agent', 'POST', '/jobs', job({ agreement: v1.body.data._id })), 403, 'only proposed, not active');
  const v2 = await api('Agent', 'POST', `/recruitment/requests/${S.req}/agreements`, terms());
  expect(v2, 201);
  assert.equal(v2.body.data.version, 2);
  assert.equal((await model('RecruitmentAgreement').findById(v1.body.data._id)).status, 'superseded');
  expect(await api('Owner', 'POST', `/recruitment/agreements/${v1.body.data._id}/accept`), 409, 'old version');
  const acc = await api('Owner', 'POST', `/recruitment/agreements/${v2.body.data._id}/accept`);
  expect(acc, 200);
  assert.equal(acc.body.data.status, 'active');
  S.agreement = v2.body.data._id;
  expect(await api('Other', 'POST', '/jobs', job({ agreement: S.agreement })), 403, 'another agent');
  const posted = await api('Agent', 'POST', '/jobs', job({ agreement: S.agreement }));
  expect(posted, 201);
  S.job = posted.body.data._id;
  const j = await model('Job').findById(S.job);
  assert.equal(j.status, 'active');
  assert.equal(j.company, 'Punjab College');
  assert.equal(String(j.institution), String(S.inst._id));
  assert.equal(String(j.recruitmentRequest), String(S.req));
  expect(await api('Owner', 'PATCH', `/jobs/${S.job}`, { title: 'Changed' }), 403, 'institute does not run an agreement job');
});

test('only the institute confirms joining; fee follows the agreement and platform fee is 0%', async () => {
  const a = await api('Cand', 'POST', `/jobs/${S.job}/apply`, { coverLetter: 'Hi' });
  expect(a, 201);
  S.app = a.body.data._id;
  expect(await api('Agent', 'PATCH', `/jobs/applications/${S.app}/status`, { status: 'hired' }), 200);
  let app = await model('JobApplication').findById(S.app);
  assert.equal(app.joining.confirmed, false, 'agent alone cannot confirm');
  assert.equal(await model('Commission').countDocuments(), 0);
  expect(await api('Cand', 'POST', `/jobs/applications/${S.app}/confirm-joining`), 409, 'candidate does not confirm agreement jobs');
  assert.ok(await model('Notification').findOne({ user: u.Owner._id, title: /Confirm joining/ }));
  const hires = (await api('Owner', 'GET', `/recruitment/hires?institution=${S.inst._id}`)).body.data;
  assert.equal(hires.length, 1);
  expect(await api('Agent', 'POST', `/recruitment/hires/${S.app}/confirm`, { monthlySalary: 90000 }), 403);
  const c = await api('Owner', 'POST', `/recruitment/hires/${S.app}/confirm`, { monthlySalary: 90000 });
  expect(c, 200);
  app = await model('JobApplication').findById(S.app);
  assert.equal(app.joining.via, 'hiring_organization');
  const inv = c.body.data.invoice;
  assert.equal(inv.grossFee, 45000, '50% of the monthly salary from the agreement');
  assert.equal(inv.platformFee, 0);
  assert.equal(inv.agentEarning, 45000);
  const com = await model('Commission').findOne({ application: S.app });
  assert.equal(com.source, 'recruitment_agreement');
  assert.equal(com.status, 'pending');
  assert.equal(com.amount, 45000);
  S.invoice = inv._id;
  expect(await api('Owner', 'POST', `/recruitment/hires/${S.app}/confirm`, { monthlySalary: 90000 }), 409, 'only once');
});

test('payment: no destination until Super Admin sets it; proof → admin verifies → earning available', async () => {
  const d = await api('Owner', 'GET', `/recruitment/invoices/${S.invoice}`);
  assert.deepEqual(d.body.data.payTo, { mode: '', text: '' });
  expect(await api('Admin', 'PUT', '/admin/recruitment/settings', { platformFeePercent: 0, payment: { mode: 'platform' } }), 422, 'platform mode needs bank details');
  expect(await api('Admin', 'PUT', '/admin/recruitment/settings', { platformFeePercent: 0, payment: { mode: 'agent' } }), 422, 'money never goes straight to the agent');
  expect(await api('Admin', 'PUT', '/admin/recruitment/settings', { platformFeePercent: 0, payment: { mode: 'platform', instructions: 'Bank: Test Bank\nIBAN: PK00TEST' } }), 200);
  assert.match((await api('Owner', 'GET', `/recruitment/invoices/${S.invoice}`)).body.data.payTo.text, /PK00TEST/);
  expect(await api('Cand', 'GET', `/recruitment/invoices/${S.invoice}`), 403);
  expect(await api('Agent', 'POST', `/recruitment/invoices/${S.invoice}/proof`, { reference: 'T1', amount: 45000 }), 403, 'agent cannot submit proof');
  expect(await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/proof`, { reference: 'T1', amount: 45000, file: { name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' } }), 422);
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  const p = await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/proof`, { reference: 'TRX-778', amount: 45000, file: { name: 'slip.png', data: png } });
  expect(p, 200);
  assert.equal(p.body.data.status, 'pending_verification');
  const proofId = p.body.data.proofs[0]._id;
  const file = await api('Admin', 'GET', `/admin/recruitment/invoices/${S.invoice}/proofs/${proofId}`);
  expect(file, 200);
  assert.equal(file.type, 'image/png');
  expect(await api('Other', 'GET', `/recruitment/invoices/${S.invoice}/proofs/${proofId}`), 403);
  expect(await api('Owner', 'POST', `/admin/recruitment/invoices/${S.invoice}/verify`, { decision: 'approve' }), 403, 'not an admin');
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${S.invoice}/verify`, { decision: 'more_info' }), 422, 'reason needed');
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${S.invoice}/verify`, { decision: 'more_info', note: 'Slip is unreadable' }), 200);
  assert.equal((await model('Commission').findOne({ application: S.app })).status, 'pending', 'not released before money is verified');
  expect(await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/proof`, { reference: 'TRX-778', amount: 45000 }), 200);
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${S.invoice}/verify`, { decision: 'approve' }), 200);
  assert.equal((await model('RecruitmentInvoice').findById(S.invoice)).status, 'paid');
  assert.equal((await model('Commission').findOne({ application: S.app })).status, 'available');
});

test('replacement and refund follow the agreement terms and need an admin decision', async () => {
  expect(await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/left`, {}), 422);
  const left = await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/left`, { reason: 'Resigned after 3 weeks' });
  expect(left, 200);
  assert.equal(left.body.data.replacement.status, 'awaiting_replacement', 'within the agreed 60 days');
  expect(await api('Owner', 'POST', `/recruitment/invoices/${S.invoice}/escalate`, { note: 'x' }), 409, 'deadline not passed');
  expect(await api('Agent', 'POST', `/recruitment/invoices/${S.invoice}/escalate`, { note: 'Cannot find a replacement' }), 200);
  let inv = await model('RecruitmentInvoice').findById(S.invoice);
  assert.equal(inv.replacement.status, 'refund_review');
  assert.equal((await model('Commission').findOne({ application: S.app })).status, 'available', 'nothing refunded automatically');
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${S.invoice}/review`, { outcome: 'refunded' }), 422, 'decision must be recorded');
  expect(await api('Admin', 'POST', `/admin/recruitment/invoices/${S.invoice}/review`, { outcome: 'refunded', note: 'Full refund of PKR 45000 by bank transfer' }), 200);
  inv = await model('RecruitmentInvoice').findById(S.invoice);
  assert.equal(inv.replacement.status, 'refunded');
  assert.equal((await model('Commission').findOne({ application: S.app })).status, 'cancelled');
});

test('a package fee is invoiced only when all covered hires are confirmed; ending closes jobs', async () => {
  const r = await api('Owner', 'POST', '/recruitment/requests', { institution: S.inst._id, agent: u.Agent._id, positions: [{ title: 'Clerk', vacancies: 2 }] });
  await api('Agent', 'POST', `/recruitment/requests/${r.body.data._id}/respond`, { action: 'accept' });
  const ag = await api('Agent', 'POST', `/recruitment/requests/${r.body.data._id}/agreements`, terms({ feeModel: 'package', packageAmount: 60000, packageHires: 2, replacement: {} }));
  await api('Owner', 'POST', `/recruitment/agreements/${ag.body.data._id}/accept`);
  const j = await api('Agent', 'POST', '/jobs', job({ title: 'Office Clerk', category: 'administration', agreement: ag.body.data._id, description: 'Office clerk for admissions records at our Lahore campus. Intermediate and MS Office required.' }));
  expect(j, 201);
  await account('Cand2', 'student');
  await model('Resume').create({ user: u.Cand2._id, skills: [] });
  const apps = [];
  for (const who of ['Cand', 'Cand2']) apps.push((await api(who, 'POST', `/jobs/${j.body.data._id}/apply`, {})).body.data._id);
  for (const id of apps) await api('Agent', 'PATCH', `/jobs/applications/${id}/status`, { status: 'hired' });
  expect(await api('Owner', 'POST', `/recruitment/hires/${apps[1]}/decline`, {}), 422);
  const first = await api('Owner', 'POST', `/recruitment/hires/${apps[0]}/confirm`, {});
  expect(first, 200);
  assert.equal(first.body.data.invoice, null, 'first of two package hires');
  const second = await api('Owner', 'POST', `/recruitment/hires/${apps[1]}/confirm`, {});
  assert.equal(second.body.data.invoice.grossFee, 60000);
  expect(await api('Owner', 'POST', `/recruitment/agreements/${ag.body.data._id}/end`), 200);
  assert.equal((await model('Job').findById(j.body.data._id)).status, 'filled');
});
