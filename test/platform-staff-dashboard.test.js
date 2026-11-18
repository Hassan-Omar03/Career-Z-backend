// Client scope 6.1 / audit point 25: a platform staff member's dashboard and access follow the
// departments the Super Admin gave them.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'audit-checkpoints-test';
const notifications = require('../src/services/notification.service');
const adminNotes = mock.method(notifications, 'notifyAdmins', async () => []);
for (const fn of ['notifyMany', 'notifyParentsOfStudent']) if (notifications[fn]) mock.method(notifications, fn, async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile'), Course = m('Course'), Enrollment = m('Enrollment');

let mongo, server, base, mod, support, admin;
const token = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const call = async (method, p, body, auth) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token(auth) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const make = async (fullName, email, role) => {
  const u = await User.create({ fullName, email, passwordHash: await User.hashPassword('Good@Pass123'), emailVerified: true, roles: [role], status: 'active' });
  await RoleRequest.create({ user: u._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 864e5) });
  await UserProfile.updateOne({ user: u._id, role }, { $set: { completed: true, percent: 100 } }, { upsert: true });
  return u;
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  mod = await make('Mod Staff', 'mod@ps.test', 'platform_staff');
  support = await make('Support Staff', 'support@ps.test', 'platform_staff');
  admin = await make('Admin', 'admin@ps.test', 'admin');
  const StaffProfile = m('StaffProfile');
  await StaffProfile.create([{ user: mod._id, departments: ['moderation'], title: 'Content Moderator', addedBy: admin._id }, { user: support._id, departments: ['support'], addedBy: admin._id }]);
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});


test('a staff member reads their own departments; an admin has all', async () => {
  const me = await call('GET', '/admin/staff/me', undefined, mod);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body.data.departments, ['moderation']);
  assert.equal(me.body.data.title, 'Content Moderator');
  const all = await call('GET', '/admin/staff/me', undefined, admin);
  assert.equal(all.body.data.all, true);
});

test('moderation staff can work on listings but not open full user records', async () => {
  assert.equal((await call('GET', '/admin/moderation/listings', undefined, mod)).status, 200);
  assert.equal((await call('GET', '/admin/moderation/users', undefined, mod)).status, 403);
  assert.equal((await call('GET', '/admin/moderation/listings', undefined, support)).status, 403, 'support staff cannot moderate');
  assert.equal((await call('GET', '/admin/moderation/users', undefined, admin)).status, 200);
});

test('each department reaches only its own work', async () => {
  assert.equal((await call('GET', '/complaints', undefined, support)).status, 200);
  assert.equal((await call('GET', '/complaints', undefined, mod)).status, 403);
  assert.equal((await call('GET', '/admin/finance', undefined, support)).status, 403);
});

test('over HTTP, a signed-in owner gets their institution\'s own roles; PATCH cannot admit an applicant', async () => {
  const owner = await make('Inst Owner', 'owner@ps.test', 'institution_owner');
  const inst = await m('Institution').create({ name: 'HTTP School', slug: 'http-school', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved', status: 'active', customRoles: [{ key: 'custom_coach', label: 'Coach', permissions: [] }] });
  const roles = await call('GET', `/institutions/staff-roles?institution=${inst._id}`, undefined, owner);
  assert.equal(roles.status, 200);
  assert.ok(roles.body.data.roles.some((r) => r.key === 'custom_coach'), 'custom roles come back for the signed-in owner');
  const anon = await call('GET', `/institutions/staff-roles?institution=${inst._id}`);
  assert.ok(!anon.body.data.roles.some((r) => r.custom), 'not for a visitor');
  const applicant = await make('Applicant', 'applicant@ps.test', 'student');
  const application = await m('InstitutionApplication').create({ institution: inst._id, applicant: applicant._id, program: 'Grade 1', status: 'submitted', submittedAt: new Date() });
  const patched = await call('PATCH', `/institution-applications/${application._id}`, { status: 'accepted' }, owner);
  assert.equal(patched.status, 422, JSON.stringify(patched.body));
});
