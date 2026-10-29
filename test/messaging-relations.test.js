const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Super Admin Comments & Ratings Management: every rating in one place, hide / show / edit / delete,
// tutor↔student, donor↔sponsored student, visa consultant, institute↔institute; strangers stay blocked.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@rel.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const oid = () => new mongoose.Types.ObjectId();
const can = (a, b) => require('../src/utils/messageAccess').canCommunicate(u[a]._id, u[b]._id);
const contacts = async (a) => (await require('../src/utils/messageAccess').communicationContacts(u[a]._id)).map((c) => String(c.user._id));

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const [n, r] of [['Emp', 'employer'], ['Hr', 'employer'], ['Cand', 'student'], ['Owner', 'institution'], ['Owner2', 'institution'], ['Tutor', 'teacher'], ['Kid', 'student'], ['Donor', 'donor'], ['Agent', 'education_agent'], ['Stranger', 'student'], ['Stranger2', 'employer']]) await account(n, r);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const job = await model('Job').create({ postedBy: u.Emp._id, title: 'Nurse', company: 'Care', country: 'PK', status: 'active', description: 'Nurse job.' });
  const app1 = await model('JobApplication').create({ job: job._id, applicant: u.Cand._id, status: 'pending' });
  await model('EmployerStaff').create({ employer: u.Emp._id, member: u.Hr._id, role: 'hr', status: 'active', permissions: ['manage_applicants'] });
  const s1 = await model('Institution').create({ name: 'One', slug: 'one', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  await model('Institution').create({ name: 'Two', slug: 'two', type: 'school', country: 'PK', owner: u.Owner2._id, verificationStatus: 'approved', status: 'active' });
  await model('InstitutionEmployerPartnership').create({ institution: s1._id, employer: u.Emp._id, requestedBy: u.Owner._id, requestedSide: 'institution', status: 'active' });
  await model('TeacherStudentLink').collection.insertOne({ teacher: u.Tutor._id, student: u.Kid._id, status: 'active', createdAt: new Date() });
  await model('Sponsorship').collection.insertOne({ donor: u.Donor._id, student: u.Kid._id, scholarship: oid(), application: oid(), status: 'active', createdAt: new Date() });
  await model('VisaCase').collection.insertOne({ candidate: u.Cand._id, application: app1._id, job: job._id, hiringSide: u.Emp._id, consultant: u.Agent._id, status: 'active', stages: [], createdAt: new Date() });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('employer ↔ candidate who applied, and the company staff ↔ candidate', async () => {
  assert.equal(await can('Emp', 'Cand'), true);
  assert.equal(await can('Cand', 'Emp'), true);
  assert.equal(await can('Hr', 'Cand'), true, 'company HR');
  assert.equal(await can('Hr', 'Emp'), true, 'staff ↔ company');
  assert.ok((await contacts('Emp')).includes(String(u.Cand._id)));
  assert.ok((await contacts('Cand')).includes(String(u.Emp._id)));
  assert.equal(await can('Stranger2', 'Cand'), false, 'another employer');
});

test('institute ↔ partner employer, institute ↔ institute', async () => {
  assert.equal(await can('Owner', 'Emp'), true);
  assert.ok((await contacts('Emp')).includes(String(u.Owner._id)));
  assert.equal(await can('Owner', 'Owner2'), true);
  assert.equal(await can('Owner2', 'Emp'), false, 'no partnership');
});

test('tutor ↔ direct student, donor ↔ sponsored student, visa consultant ↔ candidate', async () => {
  assert.equal(await can('Tutor', 'Kid'), true);
  assert.equal(await can('Donor', 'Kid'), true);
  assert.ok((await contacts('Kid')).includes(String(u.Donor._id)));
  assert.equal(await can('Agent', 'Cand'), true);
  assert.equal(await can('Donor', 'Stranger'), false);
  assert.equal(await can('Stranger', 'Kid'), false);
});

test('a block still wins, and the message API follows the same rules', async () => {
  expect(await api('Emp', 'POST', '/messages', { to: String(u.Cand._id), text: 'Hello, when can you come for an interview?' }), 201);
  expect(await api('Stranger2', 'POST', '/messages', { to: String(u.Cand._id), text: 'Hi' }), 403);
  await model('BlockedUser').create({ blocker: u.Cand._id, blocked: u.Emp._id });
  assert.equal(await can('Emp', 'Cand'), false);
});
