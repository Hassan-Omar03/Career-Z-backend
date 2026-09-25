const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notifyMany', async () => []);

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Attendance = require('../src/models/Attendance');
const LiveClassSession = require('../src/models/LiveClassSession');
const ctrl = require('../src/controllers/liveClass.controller');

let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

test('assigned teacher schedules and starts, enrolled student joins, and ending records attendance', async () => {
  const owner = await User.create({ fullName: 'Owner', email: 'live-owner@test.local', passwordHash: 'unused', roles: ['institution_owner'] });
  const teacher = await User.create({ fullName: 'Teacher', email: 'live-teacher@test.local', passwordHash: 'unused', roles: ['teacher'] });
  const student = await User.create({ fullName: 'Student', email: 'live-student@test.local', passwordHash: 'unused', roles: ['student'] });
  const absentStudent = await User.create({ fullName: 'Absent', email: 'live-absent@test.local', passwordHash: 'unused', roles: ['student'] });
  const institution = await Institution.create({ owner: owner._id, name: 'CareerZ University', slug: 'careerz-live-test', type: 'university', country: 'PK', verificationStatus: 'approved' });
  const section = await ClassSection.create({ institution: institution._id, name: 'BSCS Semester 1', academicYear: '2026-2030' });
  const course = await Course.create({ institution: institution._id, classSection: section._id, teacher: teacher._id, title: 'Programming Fundamentals', subject: 'Programming Fundamentals', published: true });
  await Enrollment.create([{ student: student._id, course: course._id }, { student: absentStudent._id, course: course._id }]);

  const scheduled = await invoke(ctrl.schedule, { user: teacher, body: { institution: institution._id, course: course._id, title: 'PF Live Lecture', scheduledStart: new Date(Date.now() - 60000), scheduledEnd: new Date(Date.now() + 3600000) } });
  assert.equal(scheduled.status, 201);
  assert.equal(scheduled.body.data.status, 'scheduled');
  assert.match(scheduled.body.data.roomName, /^careerz-/);

  const started = await invoke(ctrl.start, { user: teacher, params: { id: scheduled.body.data._id } });
  assert.equal(started.body.data.status, 'live');
  await invoke(ctrl.join, { user: student, params: { id: scheduled.body.data._id } });
  await invoke(ctrl.leave, { user: student, params: { id: scheduled.body.data._id } });
  await invoke(ctrl.end, { user: teacher, params: { id: scheduled.body.data._id } });

  const session = await LiveClassSession.findById(scheduled.body.data._id);
  assert.equal(session.status, 'ended');
  const attendance = await Attendance.findOne({ course: course._id });
  assert.equal(attendance.records.find((row) => String(row.student) === String(student._id)).status, 'present');
  assert.equal(attendance.records.find((row) => String(row.student) === String(absentStudent._id)).status, 'absent');
  assert.equal(attendance.records.find((row) => String(row.student) === String(student._id)).method, 'live');
});
