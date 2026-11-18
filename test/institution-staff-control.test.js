// Client scope 6 / master 5.6: the owner suspends and reinstates staff, makes roles of their own, and
// the client's missing roles exist. A suspended person loses every staff right until reinstated.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ctrl = require('../src/controllers/institution.controller');
const { hasStaffPermission, STAFF_ROLES } = require('../src/utils/staffRoles');

let mongo, owner, clerk, coach, inst;
function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}
const mk = (name, roles) => User.create({ fullName: name, email: `${name.toLowerCase().replace(/\s/g, '')}@sc.test`, passwordHash: 'x', roles, emailVerified: true });
const fresh = () => Institution.findById(inst._id);

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await mk('Owner', ['institution_owner']);
  clerk = await mk('Fee Clerk', ['institution_staff']);
  coach = await mk('Coach', ['institution_staff']);
  inst = await Institution.create({ name: 'Green Valley School', slug: 'gvs', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved', status: 'active' });
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('the client\'s missing roles exist', () => {
  for (const key of ['director', 'trainer', 'student_affairs']) assert.ok(STAFF_ROLES[key], key);
});

test('owner makes a custom role, gives it to staff, and edits it; hand-set permissions are kept', async () => {
  const made = await invoke(ctrl.createCustomRole, { user: owner, params: { id: String(inst._id) }, body: { label: 'Sports Coordinator', permissions: ['communication:send'] } });
  assert.equal(made.status, 201, made.body.message);
  const key = made.body.data.key;
  assert.equal(key, 'custom_sports_coordinator');
  assert.equal((await invoke(ctrl.createCustomRole, { user: owner, params: { id: String(inst._id) }, body: { label: 'sports coordinator' } })).status, 409, 'no duplicate names');
  assert.equal((await invoke(ctrl.createCustomRole, { user: owner, params: { id: String(inst._id) }, body: { label: 'X Role', permissions: ['nope'] } })).status, 422);
  assert.equal((await invoke(ctrl.createCustomRole, { user: clerk, params: { id: String(inst._id) }, body: { label: 'Mine' } })).status, 403, 'only the owner');

  assert.equal((await invoke(ctrl.addStaff, { user: owner, params: { id: String(inst._id) }, body: { userId: String(coach._id), role: key } })).status, 200);
  assert.equal((await invoke(ctrl.addStaff, { user: owner, params: { id: String(inst._id) }, body: { userId: String(clerk._id), role: key, permissions: ['fee:manage'] } })).status, 200);
  let i = await fresh();
  assert.deepEqual(i.staff.find((s) => String(s.user) === String(coach._id)).permissions, ['communication:send'], 'the role gives its permissions');

  const edited = await invoke(ctrl.updateCustomRole, { user: owner, params: { id: String(inst._id), key }, body: { permissions: ['communication:send', 'students:manage'] } });
  assert.equal(edited.status, 200, edited.body.message);
  assert.equal(edited.body.data.updatedStaff, 1);
  i = await fresh();
  assert.deepEqual(i.staff.find((s) => String(s.user) === String(coach._id)).permissions.sort(), ['communication:send', 'students:manage']);
  assert.deepEqual(i.staff.find((s) => String(s.user) === String(clerk._id)).permissions, ['fee:manage'], 'hand-set permissions stay');

  const catalog = await invoke(ctrl.listStaffRoles, { user: owner, query: { institution: String(inst._id) } });
  assert.ok(catalog.body.data.roles.some((r) => r.key === key && r.custom));
  assert.ok(!(await invoke(ctrl.listStaffRoles, { user: await mk('Stranger', ['student']), query: { institution: String(inst._id) } })).body.data.roles.some((r) => r.custom), 'outsiders do not see an institution\'s roles');
  assert.equal((await invoke(ctrl.deleteCustomRole, { user: owner, params: { id: String(inst._id), key } })).status, 409, 'in use');
});

test('a suspended staff member loses access, keeps their setup, and gets it back on reinstatement', async () => {
  assert.equal(hasStaffPermission(await fresh(), clerk._id, 'fee:manage'), true);
  const s = await invoke(ctrl.suspendStaff, { user: owner, params: { id: String(inst._id), userId: String(clerk._id) }, body: { reason: 'Fee audit' } });
  assert.equal(s.status, 200, s.body.message);
  let i = await fresh();
  assert.equal(hasStaffPermission(i, clerk._id, 'fee:manage'), false);
  assert.ok(!i.staff.some((x) => String(x.user) === String(clerk._id)));
  assert.equal(i.suspendedStaff[0].reason, 'Fee audit');
  assert.equal((await invoke(ctrl.addStaff, { user: owner, params: { id: String(inst._id) }, body: { userId: String(clerk._id), role: 'accountant' } })).status, 409, 'cannot be added twice while suspended');
  const people = await invoke(ctrl.staffPeople, { user: owner, params: { id: String(inst._id) } });
  assert.equal(people.body.data.suspended[0].fullName, 'Fee Clerk');
  assert.equal((await invoke(ctrl.staffPeople, { user: coach, params: { id: String(inst._id) } })).status, 403);
  const r = await invoke(ctrl.reinstateStaff, { user: owner, params: { id: String(inst._id), userId: String(clerk._id) } });
  assert.equal(r.status, 200, r.body.message);
  i = await fresh();
  assert.equal(hasStaffPermission(i, clerk._id, 'fee:manage'), true);
  assert.equal(i.suspendedStaff.length, 0);
});

test('teachers are not suspended here', async () => {
  const t = await mk('Teacher', ['teacher']);
  await Institution.updateOne({ _id: inst._id }, { $push: { staff: { user: t._id, role: 'teacher' } } });
  assert.equal((await invoke(ctrl.suspendStaff, { user: owner, params: { id: String(inst._id), userId: String(t._id) } })).status, 422);
});

test('a removed staff member is told', async () => {
  const before = notifications.notify.mock.calls.length;
  const r = await invoke(ctrl.removeStaff, { user: owner, params: { id: String(inst._id), userId: String(coach._id) } });
  assert.equal(r.status, 200, r.body.message);
  const sent = notifications.notify.mock.calls.slice(before).find((c) => String(c.arguments[0]) === String(coach._id));
  assert.ok(sent && /removed from the staff of Green Valley School/.test(sent.arguments[1].title));
});

test('the owner sees recent staff changes, newest first', async () => {
  const r = await invoke(ctrl.staffHistory, { user: owner, params: { id: String(inst._id) } });
  assert.equal(r.status, 200, r.body.message);
  const actions = r.body.data.map((l) => l.action);
  assert.ok(actions.includes('removed') && actions.includes('suspended') && actions.includes('reinstated') && actions.includes('added'), actions.join());
  assert.equal(r.body.data[0].action, 'removed', 'newest first');
  assert.equal(r.body.data[0].fromRole, 'Sports Coordinator', 'role names are kept as shown');
  assert.equal((await invoke(ctrl.staffHistory, { user: clerk, params: { id: String(inst._id) } })).status, 403, 'only the owner');
});
