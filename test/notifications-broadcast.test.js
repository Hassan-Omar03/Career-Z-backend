const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.VAPID_PUBLIC_KEY = '';
const emailService = require('../src/services/email.service');
const emailed = [];
mock.method(emailService, 'sendEmail', async ({ to }) => { emailed.push(to); });
const webpush = require('web-push');
const pushed = [];
mock.method(webpush, 'sendNotification', async (sub) => { pushed.push(sub.endpoint); });
mock.method(webpush, 'setVapidDetails', () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const Notification = require('../src/models/Notification');
const PushSubscription = require('../src/models/PushSubscription');
const ctrl = require('../src/controllers/notification.controller');
const staffPermissions = require('../src/controllers/staffPermission.controller');
const pushService = require('../src/services/push.service');

const models = [User, Institution, StudentProfile, StudentInstitutionMembership, Notification, PushSubscription];
let mongo, owner, staff, primaryStudent, secondaryStudent, pendingStudent, institution;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  emailed.length = 0; pushed.length = 0;
  [owner, staff, primaryStudent, secondaryStudent, pendingStudent] = await User.create(['owner', 'staff', 'primary', 'secondary', 'pending'].map((n) => ({ fullName: n, email: `${n}@notify.test`, passwordHash: 'x' })));
  institution = await Institution.create({ name: 'GCUF', slug: 'gcuf-notify', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved', staff: [{ user: staff._id, role: 'staff', permissions: [] }] });
  const otherInstitution = new mongoose.Types.ObjectId();
  await StudentProfile.create([{ user: primaryStudent._id, primaryInstitution: institution._id }, { user: secondaryStudent._id, primaryInstitution: otherInstitution }]);
  await StudentInstitutionMembership.create([
    { student: secondaryStudent._id, institution: institution._id, status: 'active' },
    { student: pendingStudent._id, institution: institution._id, status: 'pending' }
  ]);
});

function invoke(handler, { user, params = {}, body = {}, headers = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, headers }, res, reject)).catch(reject);
  });
}
const flush = () => new Promise((r) => setTimeout(r, 30));

test('broadcast reaches primary AND active secondary-institution students, by email too, not pending ones', async () => {
  const result = await invoke(ctrl.broadcast, { user: owner, params: { id: institution.id }, body: { audience: 'students', title: 'Holiday', body: 'Closed Friday' } });
  assert.equal(result.body.data.sentTo, 2);
  const recipients = (await Notification.find({})).map((n) => n.user.toString()).sort();
  assert.deepEqual(recipients, [primaryStudent.id, secondaryStudent.id].sort());
  assert.equal((await Notification.findOne({ user: secondaryStudent._id })).title, 'GCUF: Holiday');
  assert.deepEqual(emailed.sort(), ['primary@notify.test', 'secondary@notify.test']);
});

test('only the owner or staff granted "communication:send" can broadcast', async () => {
  await assert.rejects(invoke(ctrl.broadcast, { user: staff, params: { id: institution.id }, body: { audience: 'all', title: 'x' } }), { statusCode: 403 });
  await assert.rejects(invoke(staffPermissions.updateStaffPermissions, { user: staff, params: { id: institution.id, userId: staff.id }, body: { permissions: ['communication:send'] } }), { statusCode: 403 });
  await invoke(staffPermissions.updateStaffPermissions, { user: owner, params: { id: institution.id, userId: staff.id }, body: { permissions: ['communication:send'] } });
  const ok = await invoke(ctrl.broadcast, { user: staff, params: { id: institution.id }, body: { audience: 'students', title: 'Allowed', channels: ['no-email'] } });
  assert.equal(ok.body.data.sentTo, 2);
  assert.equal(emailed.length, 0);
  await assert.rejects(invoke(staffPermissions.updateStaffPermissions, { user: owner, params: { id: institution.id, userId: staff.id }, body: { permissions: ['god:mode'] } }), { statusCode: 422 });
});

test('staff permission edits keep separately-managed AI permissions', async () => {
  await Institution.updateOne({ _id: institution._id, 'staff.user': staff._id }, { $set: { 'staff.$.permissions': ['ai:use'] } });
  const res = await invoke(staffPermissions.updateStaffPermissions, { user: owner, params: { id: institution.id, userId: staff.id }, body: { permissions: ['fee:manage'] } });
  assert.deepEqual(res.body.data.permissions.sort(), ['ai:use', 'fee:manage']);
});

test('push subscriptions: saved per user, notifications are pushed to them, and they can be removed', async () => {
  process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv'; pushService._resetForTests();
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k1', auth: 'k2' } };
  await assert.rejects(invoke(ctrl.savePushSubscription, { user: primaryStudent, body: { endpoint: 'http://insecure', keys: sub.keys } }), { statusCode: 422 });
  await invoke(ctrl.savePushSubscription, { user: primaryStudent, body: sub });
  assert.equal((await invoke(ctrl.getPushPublicKey, { user: primaryStudent })).body.data.publicKey, 'pub');
  await invoke(ctrl.broadcast, { user: owner, params: { id: institution.id }, body: { audience: 'students', title: 'Exam moved' } });
  await flush();
  assert.deepEqual(pushed, ['https://push.example/abc']);
  await invoke(ctrl.deletePushSubscription, { user: secondaryStudent, body: { endpoint: sub.endpoint } }); // not theirs
  assert.equal(await PushSubscription.countDocuments(), 1);
  await invoke(ctrl.deletePushSubscription, { user: primaryStudent, body: { endpoint: sub.endpoint } });
  assert.equal(await PushSubscription.countDocuments(), 0);
  process.env.VAPID_PUBLIC_KEY = ''; process.env.VAPID_PRIVATE_KEY = ''; pushService._resetForTests();
});
