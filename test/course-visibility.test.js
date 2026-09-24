const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
let notifiedUserIds = [];
mock.method(notifications, 'notify', async (userId) => { notifiedUserIds.push(userId.toString()); });

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Enrollment = require('../src/models/Enrollment');
const ctrl = require('../src/controllers/course.controller');

let mongo, teacher, student, institution;
const models = [User, Course, Institution, ClassSection, Enrollment];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  notifiedUserIds = [];
  teacher = await User.create({ fullName: 'Vis Teacher', email: 'vis-teacher@test.local', passwordHash: 'unused', roles: ['teacher'] });
  student = await User.create({ fullName: 'Vis Student', email: 'vis-student@test.local', passwordHash: 'unused', roles: ['student'] });
  institution = await Institution.create({ name: 'Vis Institution', slug: 'vis-institution', type: 'school', country: 'PK', owner: teacher._id, verificationStatus: 'approved' });
});

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query }, res, reject)).catch(reject);
  });
}

test('a testOnly course never appears in the public course list', async () => {
  await Course.create({ title: 'Real Public Course', teacher: teacher._id, published: true, isFree: true });
  await Course.create({ title: '__SOME_VERIFICATION_FIXTURE__', teacher: teacher._id, published: true, isFree: true, testOnly: true });

  const res = await invoke(ctrl.listCourses, { user: null });
  const titles = res.body.data.map((c) => c.title);
  assert.ok(titles.includes('Real Public Course'));
  assert.ok(!titles.includes('__SOME_VERIFICATION_FIXTURE__'), 'testOnly course leaked into the public list');
});

test('an institution course is never created as free/public-enrollable', async () => {
  const course = await Course.create({ title: 'Institution Course', teacher: teacher._id, institution: institution._id, published: true, isFree: false });
  assert.equal(course.isFree, false);

  const res = await invoke(ctrl.listCourses, { user: null, query: { institution: institution._id.toString() } });
  const found = res.body.data.find((c) => c._id.toString() === course._id.toString());
  assert.ok(found);
  assert.equal(found.isFree, false, 'institution course must never be publicly free-enrollable');
});

test('sharing a resource notifies a student whose enrollment already flipped to completed', async () => {
  const course = await Course.create({ title: 'Progress Course', teacher: teacher._id, published: true, isFree: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'completed', progressPercent: 100, overallScore: 100 });

  const res = await invoke(ctrl.shareAiResource, { user: teacher, params: { id: course._id }, body: { title: 'New Notes', content: 'Some notes.' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.notifiedCount, 1, 'a completed-but-still-enrolled student must still be notified');
  assert.ok(notifiedUserIds.includes(student._id.toString()));
});

test('sharing a resource never notifies a dropped student', async () => {
  const course = await Course.create({ title: 'Dropped Course', teacher: teacher._id, published: true, isFree: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'dropped' });

  const res = await invoke(ctrl.shareAiResource, { user: teacher, params: { id: course._id }, body: { title: 'New Notes', content: 'Some notes.' } });
  assert.equal(res.body.data.notifiedCount, 0);
  assert.ok(!notifiedUserIds.includes(student._id.toString()));
});
