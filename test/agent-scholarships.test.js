const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Agent scholarship publishing: provider details + authorization, admin approval before going
// live; with a CareerZ Donor provider the donor confirms first and decides applications; any other
// provider is an external listing (apply on their site). The agent never gets award rights.
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
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, approved = true) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@aschol.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const auth = 'The HEC scholarship office emailed us on 2 Oct 2026 to list this call (ref HEC/SCH/221).';
const listing = (extra = {}) => ({ title: 'HEC Need-Based Scholarship', amount: 50000, currency: 'PKR', country: 'PK', eligibilityCriteria: 'BS students', applicationDeadline: '2027-01-31', ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Agent', 'education_agent');
  await account('NewAgent', 'education_agent', false);
  await account('Other', 'education_agent');
  await account('Donor', 'donor');
  await account('OtherDonor', 'donor');
  await account('Stu', 'student');
  await account('Admin', 'super_admin');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
const publicIds = async () => { const r = await api(null, 'GET', '/public/scholarships'); expect(r, 200, 'public list'); return r.body.data.items.map((s) => String(s._id)); };

test('external provider: needs authorization and an https apply page; live only after admin approval', async () => {
  const provider = { type: 'government', name: 'HEC Pakistan', website: 'https://hec.gov.pk', authorization: auth };
  expect(await api('NewAgent', 'POST', '/scholarships/agent', listing({ provider, externalUrl: 'https://hec.gov.pk/apply' })), 403, 'unverified agent');
  expect(await api('Agent', 'POST', '/scholarships/agent', listing({ provider: { ...provider, authorization: 'yes' }, externalUrl: 'https://hec.gov.pk/apply' })), 422);
  expect(await api('Agent', 'POST', '/scholarships/agent', listing({ provider })), 422, 'apply page required');
  expect(await api('Agent', 'POST', '/scholarships/agent', listing({ provider, externalUrl: 'http://hec.gov.pk/apply' })), 422);
  const r = await api('Agent', 'POST', '/scholarships/agent', listing({ provider, externalUrl: 'https://hec.gov.pk/apply' }));
  expect(r, 201);
  S.ext = r.body.data._id;
  assert.equal(r.body.data.status, 'pending_review');
  assert.equal(r.body.data.donor, null);
  assert.ok(!(await publicIds()).includes(S.ext), 'not public before approval');
  expect(await api('Admin', 'POST', `/admin/scholarships/${S.ext}/decision`, { decision: 'reject' }), 422, 'reason needed');
  expect(await api('Stu', 'POST', `/admin/scholarships/${S.ext}/decision`, { decision: 'approve' }), 403);
  const queue = (await api('Admin', 'GET', '/admin/scholarships/review')).body.data;
  assert.equal(queue.length, 1);
  expect(await api('Admin', 'POST', `/admin/scholarships/${S.ext}/decision`, { decision: 'approve' }), 200);
  assert.ok((await publicIds()).includes(S.ext));
  const card = (await api(null, 'GET', `/public/scholarships/${S.ext}`)).body.data;
  assert.equal(card.provider.name, 'HEC Pakistan');
  assert.equal(card.applicationMode, 'external');
  assert.equal(card.externalUrl, 'https://hec.gov.pk/apply');
  assert.equal(card.listedByAgent, true);
  const apply = await api('Stu', 'POST', `/scholarships/${S.ext}/apply`, { statement: 'x' });
  expect(apply, 400, 'no internal applications for an outside provider');
  assert.match(apply.body.message, /provider/);
  assert.ok(await model('Notification').findOne({ user: u.Stu._id, category: 'scholarship_alert' }), 'students alerted on publish');
});

test('editing an approved listing sends it back to review; the agent can close it', async () => {
  expect(await api('Agent', 'PATCH', `/scholarships/agent/${S.ext}`, { amount: 60000 }), 200);
  assert.equal((await model('Scholarship').findById(S.ext)).status, 'pending_review');
  assert.ok(!(await publicIds()).includes(S.ext));
  expect(await api('Other', 'PATCH', `/scholarships/agent/${S.ext}`, { status: 'closed' }), 404);
  expect(await api('Agent', 'PATCH', `/scholarships/agent/${S.ext}`, { status: 'closed' }), 200);
});

test('CareerZ donor provider: donor confirms, admin approves, applications go to the donor only', async () => {
  const provider = { type: 'careerz_donor', donor: u.Donor._id, authorization: 'Agreed with the donor by phone and email on 1 Oct 2026.' };
  expect(await api('Agent', 'POST', '/scholarships/agent', listing({ provider: { ...provider, donor: u.Stu._id } })), 422, 'provider must be a verified donor');
  const r = await api('Agent', 'POST', '/scholarships/agent', listing({ title: 'Merit Award', provider }));
  expect(r, 201);
  S.int = r.body.data._id;
  assert.equal(r.body.data.applicationMode, 'internal');
  assert.equal(r.body.data.review.status, 'awaiting_donor');
  expect(await api('Admin', 'POST', `/admin/scholarships/${S.int}/decision`, { decision: 'approve' }), 409, 'donor has not confirmed');
  expect(await api('OtherDonor', 'POST', `/scholarships/${S.int}/donor-confirm`, { decision: 'confirm' }), 404);
  expect(await api('Donor', 'PATCH', `/scholarships/${S.int}`, { status: 'open' }), 409, 'donor cannot skip review');
  expect(await api('Donor', 'POST', `/scholarships/${S.int}/donor-confirm`, { decision: 'confirm' }), 200);
  expect(await api('Admin', 'POST', `/admin/scholarships/${S.int}/decision`, { decision: 'approve' }), 200);
  assert.ok((await publicIds()).includes(S.int));
  const a = await api('Stu', 'POST', `/scholarships/${S.int}/apply`, { statement: 'Top of my class' });
  expect(a, 201);
  expect(await api('Agent', 'GET', `/scholarships/${S.int}/applicants`), 403, 'agent cannot see or decide applicants');
  expect(await api('Agent', 'PATCH', `/scholarships/applications/${a.body.data._id}/status`, { status: 'approved' }), 403);
  const list = await api('Donor', 'GET', `/scholarships/${S.int}/applicants`);
  expect(list, 200);
  assert.equal(list.body.data.length, 1);
  const mine = (await api('Agent', 'GET', '/scholarships/agent/mine')).body.data.find((s) => String(s._id) === S.int);
  assert.equal(mine.applicationCount, 1);
});

test('a donor can decline a listing that names them', async () => {
  const r = await api('Agent', 'POST', '/scholarships/agent', listing({ title: 'Unagreed', provider: { type: 'careerz_donor', donor: u.OtherDonor._id, authorization: 'We think this donor would like to fund this.' } }));
  expect(await api('OtherDonor', 'POST', `/scholarships/${r.body.data._id}/donor-confirm`, { decision: 'decline', note: 'Never agreed' }), 200);
  const s = await model('Scholarship').findById(r.body.data._id);
  assert.equal(s.status, 'rejected');
  assert.ok(await model('Notification').findOne({ user: u.Agent._id, title: /Donor declined/ }));
});
