const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Institute email invitations: teachers, staff and students join by link; new accounts open
// straight on their dashboard, already joined to the institute.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
const mails = [];
mock.method(emailService, 'sendEmail', async (m) => { mails.push(m); return { ok: true }; });
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
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@inv.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const tokenFor = (email) => { const m = [...mails].reverse().find((x) => x.to === email); return m && m.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1]; };
const signup = (token, extra = {}) => api(null, 'POST', `/invites/${token}/signup`, { fullName: 'New Person', password: 'Strong#Pass2026', acceptedTerms: true, ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution_owner');
  await account('Other', 'institution_owner');
  await account('Kid', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  S.inst = await model('Institution').create({ name: 'FAST University', slug: 'fast', type: 'university', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  S.unverified = await model('Institution').create({ name: 'New School', slug: 'new-school', type: 'school', country: 'PK', owner: u.Other._id, verificationStatus: 'pending', status: 'active' });
  S.cls = await model('ClassSection').create({ institution: S.inst._id, name: 'BSCS Semester 1' });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('the institute invites teachers, staff and students by email (one or many at once)', async () => {
  expect(await api('Kid', 'POST', `/institutions/${S.inst._id}/invites`, { email: 'x@y.pk', kind: 'teacher' }), 403, 'not the owner');
  expect(await api('Other', 'POST', `/institutions/${S.unverified._id}/invites`, { email: 'x@y.pk', kind: 'teacher' }), 403, 'institute not verified');
  const r = await api('Owner', 'POST', `/institutions/${S.inst._id}/invites`, { message: 'Welcome to the CS faculty', invites: [
    { email: 'Ali.Teacher@fast.pk', name: 'Ali Raza', kind: 'teacher', designation: 'Lecturer', department: 'Computer Science' },
    { email: 'accounts@fast.pk', kind: 'staff', role: 'accountant' },
    { email: 'kid@inv.test', kind: 'student', classSection: String(S.cls._id), program: 'BS Computer Science' },
    { email: 'not-an-email', kind: 'teacher' }
  ] });
  expect(r, 200);
  assert.equal(r.body.data.sent, 3);
  assert.equal(r.body.data.failed, 1);
  const mail = mails.find((m) => m.to === 'ali.teacher@fast.pk');
  assert.match(mail.subject, /FAST University invited you/);
  assert.match(mail.text, /Lecturer/);
  assert.match(mail.text, /Welcome to the CS faculty/);
  assert.equal((await api('Owner', 'GET', `/institutions/${S.inst._id}/invites`)).body.data.length, 3);
});

test('a new teacher opens the link, sets a password and lands on the teacher dashboard, joined', async () => {
  const token = tokenFor('ali.teacher@fast.pk');
  const p = (await api(null, 'GET', `/invites/${token}`)).body.data;
  assert.equal(p.institution.name, 'FAST University');
  assert.equal(p.email, 'ali.teacher@fast.pk');
  assert.equal(p.accountExists, false);
  expect(await signup(token, { password: 'weak' }), 422, 'strong password');
  const s = await signup(token, { fullName: 'Ali Raza', phone: '03001234567' });
  expect(s, 201);
  assert.ok(s.body.data.accessToken, 'signed in at once');
  assert.equal(s.body.data.workspace, 'teacher');
  const teacher = await model('User').findOne({ email: 'ali.teacher@fast.pk' });
  assert.equal(teacher.emailVerified, true);
  const gate = await require('../src/services/accountGate.service').gateFor(teacher);
  assert.equal(gate.state, 'ok', 'no separate document check: the dashboard opens');
  const inst = await model('Institution').findById(S.inst._id);
  assert.ok(inst.staff.some((x) => String(x.user) === String(teacher._id) && x.role === 'teacher' && x.department === 'Computer Science'));
  assert.ok(await model('TeacherEmployment').exists({ teacher: teacher._id, institution: S.inst._id, status: 'active' }));
  expect(await signup(token), 409, 'a link works once');
  assert.ok(await model('Notification').exists({ user: u.Owner._id, title: /Ali Raza joined FAST University/ }));
});

test('an existing student signs in with the same email and accepts; another account cannot', async () => {
  const token = tokenFor('kid@inv.test');
  assert.equal((await api(null, 'GET', `/invites/${token}`)).body.data.accountExists, true);
  expect(await api('Other', 'POST', `/invites/${token}/accept`), 403, 'different email');
  expect(await api('Kid', 'POST', `/invites/${token}/accept`), 200);
  assert.ok(await model('StudentInstitutionMembership').exists({ student: u.Kid._id, institution: S.inst._id, status: 'active' }));
  assert.equal(String((await model('StudentProfile').findOne({ user: u.Kid._id })).classSection), String(S.cls._id));
});

test('staff join with their role and permissions; resend replaces the link; cancel stops it', async () => {
  const inv = (await api('Owner', 'GET', `/institutions/${S.inst._id}/invites?kind=staff`)).body.data[0];
  const old = tokenFor('accounts@fast.pk');
  expect(await api('Owner', 'POST', `/institutions/${S.inst._id}/invites/${inv._id}/resend`), 200);
  expect(await api(null, 'GET', `/invites/${old}`), 404, 'the old link stops working');
  expect(await signup(tokenFor('accounts@fast.pk'), { fullName: 'Sana Accounts' }), 201);
  const user = await model('User').findOne({ email: 'accounts@fast.pk' });
  assert.ok(user.roles.includes('institution_staff'));
  const member = (await model('Institution').findById(S.inst._id)).staff.find((x) => String(x.user) === String(user._id));
  assert.equal(member.role, 'accountant');
  assert.ok(member.permissions.includes('fee:manage'));
  const r = await api('Owner', 'POST', `/institutions/${S.inst._id}/invites`, { email: 'gone@fast.pk', kind: 'teacher' });
  expect(await api('Owner', 'DELETE', `/institutions/${S.inst._id}/invites/${r.body.data.results[0].id}`), 200);
  expect(await signup(tokenFor('gone@fast.pk')), 410);
});
