const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Guest job applications: apply with a CV and an email (no account) → tracking link verifies the
// email and only then reaches the hiring side → status updates by email → withdraw / confirm
// joining by the link → spam guards → retention cleanup removes the application and its CV.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.PUBLIC_SITE_URL = 'https://careerz.test';
const emailService = require('../src/services/email.service');
const emails = [];
mock.method(emailService, 'sendEmail', async (msg) => { emails.push(msg); return { ok: true }; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
const guests = require('../src/services/guestApplication.service');
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* file */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@guest.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const pdf = { name: 'cv.pdf', data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 guest cv').toString('base64') };
const form = (extra = {}) => ({ name: 'Ayesha Khan', email: 'ayesha@mail.test', phone: '03001234567', city: 'Lahore', coverLetter: 'I teach physics.', consent: true, cv: pdf, ...extra });
const tokenFrom = (mail) => /token=([a-f0-9]{48})/.exec(mail.html)[1];
const jobBody = { title: 'Physics Teacher', company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Teach physics to secondary classes at our Lahore campus. B.Sc and B.Ed required.' };

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Agent', 'education_agent', 'individual');
  await account('Stranger', 'employer', 'company');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  S.job = (await api('Employer', 'POST', '/jobs', jobBody)).body.data._id;
  S.agentJob = (await api('Agent', 'POST', '/jobs', { ...jobBody, title: 'Chemistry Teacher', company: 'City School' })).body.data._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { emails.length = 0; });

test('a guest applies with a CV; nothing reaches the employer until the emailed link is opened', async () => {
  expect(await api(null, 'POST', `/jobs/${S.job}/guest-apply`, form({ consent: false })), 422);
  expect(await api(null, 'POST', `/jobs/${S.job}/guest-apply`, form({ email: 'nope' })), 422);
  expect(await api(null, 'POST', `/jobs/${S.job}/guest-apply`, form({ cv: { name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' } })), 422);
  const r = await api(null, 'POST', `/jobs/${S.job}/guest-apply`, form());
  expect(r, 201);
  assert.equal(emails.length, 1);
  assert.match(emails[0].html, /https:\/\/careerz.test\/application-status\?token=/);
  S.token = tokenFrom(emails[0]);
  expect(await api(null, 'POST', `/jobs/${S.job}/guest-apply`, form({ name: 'Again' })), 409, 'duplicate email for the job');
  assert.equal((await api('Employer', 'GET', `/jobs/${S.job}/guest-applicants`)).body.data.length, 0, 'not verified yet');
  const t = await api(null, 'GET', `/jobs/guest/track?token=${S.token}`);
  expect(t, 200);
  assert.equal(t.body.data.stage, 'Applied');
  assert.equal(t.body.data.job.title, 'Physics Teacher');
  assert.ok(await model('Notification').findOne({ user: u.Employer._id, title: /New application \(guest\)/ }));
  const list = (await api('Employer', 'GET', `/jobs/${S.job}/guest-applicants`)).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].guest, true);
  assert.equal(list[0].status, 'viewed');
  assert.equal(list[0].trackingTokenHash, undefined);
  S.app = list[0]._id;
  expect(await api('Stranger', 'GET', `/jobs/${S.job}/guest-applicants`), 403);
  expect(await api(null, 'GET', '/jobs/guest/track?token=' + 'a'.repeat(48)), 404);
});

test('the employer downloads the CV and moves stages; each change is emailed to the guest', async () => {
  const cv = await api('Employer', 'GET', `/jobs/guest-applications/${S.app}/cv`);
  expect(cv, 200);
  assert.equal(cv.headers.get('content-type'), 'application/pdf');
  assert.match(cv.text, /guest cv/);
  expect(await api('Stranger', 'GET', `/jobs/guest-applications/${S.app}/cv`), 403);
  expect(await api('Employer', 'PATCH', `/jobs/guest-applications/${S.app}/status`, { status: 'interview', note: 'Monday 10am' }), 200);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'ayesha@mail.test');
  assert.match(emails[0].html, /Interview/);
  assert.match(emails[0].html, /Monday 10am/);
  expect(await api('Employer', 'PATCH', `/jobs/guest-applications/${S.app}/status`, { status: 'completed' }), 409);
  expect(await api('Employer', 'PATCH', `/jobs/guest-applications/${S.app}/status`, { status: 'hired' }), 200);
  const a = await model('GuestApplication').findById(S.app);
  assert.equal(a.joining.via, 'hiring_organization', 'the employer is the hiring organization');
  assert.equal((await model('Job').findById(S.job)).status, 'filled');
});

test('an agent job: the guest confirms joining by the link and the agent commission is created', async () => {
  await api(null, 'POST', `/jobs/${S.agentJob}/guest-apply`, form({ email: 'bilal@mail.test', name: 'Bilal' }));
  const token = tokenFrom(emails[0]);
  await api(null, 'GET', `/jobs/guest/track?token=${token}`);
  const [g] = (await api('Agent', 'GET', `/jobs/${S.agentJob}/guest-applicants`)).body.data;
  expect(await api('Agent', 'PATCH', `/jobs/guest-applications/${g._id}/status`, { status: 'hired' }), 200);
  assert.equal(await model('Commission').countDocuments({ guestApplication: g._id }), 0, 'agent alone cannot confirm');
  const t = (await api(null, 'GET', `/jobs/guest/track?token=${token}`)).body.data;
  assert.equal(t.canConfirmJoining, true);
  expect(await api(null, 'POST', '/jobs/guest/confirm-joining', { token }), 200);
  const c = await model('Commission').findOne({ guestApplication: g._id });
  assert.equal(c.candidateName, 'Bilal');
  assert.equal(c.application, undefined);
  expect(await api(null, 'POST', '/jobs/guest/confirm-joining', { token }), 409);
  expect(await api(null, 'POST', '/jobs/guest/withdraw', { token }), 409, 'cannot withdraw after joining');
});

test('withdraw by link; honeypot is silently dropped; retention removes the application and CV', async () => {
  const other = (await api('Employer', 'POST', '/jobs', { ...jobBody, title: 'Biology Teacher' })).body.data._id;
  const bot = await api(null, 'POST', `/jobs/${other}/guest-apply`, form({ website: 'http://spam', email: 'bot@mail.test' }));
  expect(bot, 201);
  assert.equal(await model('GuestApplication').countDocuments({ email: 'bot@mail.test' }), 0);
  assert.equal(emails.length, 0);
  await api(null, 'POST', `/jobs/${other}/guest-apply`, form({ email: 'sara@mail.test' }));
  const token = tokenFrom(emails[0]);
  expect(await api(null, 'POST', '/jobs/guest/withdraw', { token, reason: 'Took another job' }), 200);
  assert.equal((await api(null, 'GET', `/jobs/guest/track?token=${token}`)).body.data.stage, 'Withdrawn');
  // Unverified for longer than the window → removed with its CV.
  await api(null, 'POST', `/jobs/${other}/guest-apply`, form({ email: 'late@mail.test' }));
  const late = await model('GuestApplication').findOne({ email: 'late@mail.test' });
  await model('GuestApplication').collection.updateOne({ _id: late._id }, { $set: { createdAt: new Date(Date.now() - 4 * 864e5) } });
  const removed = await guests.cleanup();
  assert.equal(removed, 1);
  assert.equal(await model('PrivateFile').countDocuments({ _id: late.cv }), 0);
  const old = await model('GuestApplication').findOne({ email: 'sara@mail.test' });
  await model('GuestApplication').collection.updateOne({ _id: old._id }, { $set: { updatedAt: new Date(Date.now() - (guests.RETENTION_DAYS + 1) * 864e5) } });
  assert.equal(await guests.cleanup(), 1);
  expect(await api(null, 'GET', `/jobs/guest/track?token=${token}`), 404);
});
