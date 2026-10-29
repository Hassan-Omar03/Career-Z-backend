const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// One way to hire for an institute: Jobs & Hiring. Joined on a teaching job makes the person the
// institute's teacher immediately, with the offer's salary; no second offer to accept.
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
  let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@hire.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const job = (extra) => ({ company: 'x', country: 'PK', city: 'Lahore', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Full-time post at our Lahore campus. Relevant degree and two years of experience required.', ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution');
  await account('Teach', 'teacher');
  await account('Clerk', 'student');
  S.inst = await model('Institution').create({ name: 'City College', slug: 'city-college', type: 'college', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

async function hire(who, jobBody, salary) {
  const j = await api('Owner', 'POST', '/jobs', { ...jobBody, institution: S.inst._id });
  expect(j, 201);
  const a = await api(who, 'POST', `/jobs/${j.body.data._id}/apply`, {});
  expect(a, 201);
  expect(await api('Owner', 'POST', `/jobs/applications/${a.body.data._id}/offer`, { salary, currency: 'PKR', startDate: '2026-12-01' }), 200);
  const emp = await model('Employment').findOne({ application: a.body.data._id });
  expect(await api(who, 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted', signedName: 'Signed Candidate' }), 200);
  expect(await api('Owner', 'PATCH', `/jobs/applications/${a.body.data._id}/status`, { status: 'hired' }), 200);
}

test('joined on a teaching job → the institute\'s teacher, with the offer\'s salary, no second offer', async () => {
  await hire('Teach', job({ title: 'Physics Lecturer', category: 'teaching' }), 85000);
  const inst = await model('Institution').findById(S.inst._id);
  const staff = inst.staff.find((s) => String(s.user) === String(u.Teach._id));
  assert.equal(staff.role, 'teacher');
  assert.equal(staff.designation, 'Physics Lecturer');
  const te = await model('TeacherEmployment').findOne({ teacher: u.Teach._id, institution: S.inst._id });
  assert.equal(te.status, 'active', 'active straight away, nothing more to accept');
  assert.equal(te.monthlySalary, 85000);
  assert.ok(!(await model('User').findById(u.Teach._id)).roles.includes('institution_staff'), 'a teacher does not get the institute admin workspace');
  assert.equal((await api('Teach', 'GET', `/institutions/${S.inst._id}/reports`)).status, 403, 'no whole-institute figures for a teacher');
  assert.ok(await model('Notification').findOne({ user: u.Teach._id, title: /Welcome to City College/ }));
});

test('joined on a non-teaching job → institute staff (not a teacher)', async () => {
  await hire('Clerk', job({ title: 'Admissions Clerk', category: 'administration' }), 45000);
  const staff = (await model('Institution').findById(S.inst._id)).staff.find((s) => String(s.user) === String(u.Clerk._id));
  assert.equal(staff.role, 'staff');
  assert.ok((await model('User').findById(u.Clerk._id)).roles.includes('institution_staff'), 'non-teaching staff use the institution workspace');
  assert.equal(await model('TeacherEmployment').countDocuments({ teacher: u.Clerk._id }), 0);
});
