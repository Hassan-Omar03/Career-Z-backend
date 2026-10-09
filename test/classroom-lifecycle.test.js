const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyMany', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const LiveClassSession = require('../src/models/LiveClassSession');
const Attendance = require('../src/models/Attendance');
require('../src/models/ClassSection');
const lifecycle = require('../src/services/classroomLifecycle.service');

let db, teacher, alice, bob, course, institution;
before(async () => { db = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(db.getUri()); await Promise.all([User, Institution, Course, Enrollment, LiveClassSession, Attendance].map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => {
  await Promise.all([User, Institution, Course, Enrollment, LiveClassSession, Attendance].map((m) => m.deleteMany({})));
  [teacher, alice, bob] = await User.create(['t', 'alice', 'bob'].map((n) => ({ fullName: n, email: `${n}@life.test`, passwordHash: 'x' })));
  institution = await Institution.create({ name: 'Uni', slug: 'uni-life', type: 'school', country: 'PK', owner: teacher._id });
  course = await Course.create({ title: 'Physics', teacher: teacher._id, institution: institution._id });
  await Enrollment.create([{ student: alice._id, course: course._id, status: 'active' }, { student: bob._id, course: course._id, status: 'active' }]);
});
const schedule = (startOffsetMin, endOffsetMin, extra = {}) => LiveClassSession.create({ institution: institution._id, course: course._id, classSection: new mongoose.Types.ObjectId(), teacher: teacher._id, createdBy: teacher._id, title: 'Lecture', scheduledStart: new Date(Date.now() + startOffsetMin * 60000), scheduledEnd: new Date(Date.now() + endOffsetMin * 60000), roomName: `r-${Math.random()}`, ...extra });

test('starting class control starts the scheduled class happening now; joins become attendance; ending stores engagement and ends it', async () => {
  const scheduled = await schedule(5, 65); // starts in 5 min — inside the 15-minute early window
  const linked = await lifecycle.linkLiveSession({ courseId: course._id, teacherId: teacher._id });
  assert.equal(linked, scheduled.id);
  let s = await LiveClassSession.findById(scheduled._id);
  assert.equal(s.status, 'live'); assert.equal(s.startedByClassControl, true);
  await lifecycle.recordJoin(linked, alice._id);
  await lifecycle.recordJoin(linked, alice._id); // rejoin does not duplicate
  s = await LiveClassSession.findById(scheduled._id);
  assert.equal(s.participants.length, 1);
  const ended = await lifecycle.finish(linked, teacher._id, { averageEnergy: 72, attentiveCount: 1, participantCount: 1, record: null });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.engagement.averageEnergy, 72);
  const attendance = await Attendance.find({ liveClassSession: scheduled._id });
  const rows = attendance.flatMap((a) => a.records || [a]);
  const byStudent = Object.fromEntries(rows.map((r) => [String(r.student), r.status]));
  assert.equal(byStudent[alice.id], 'present');
  assert.equal(byStudent[bob.id], 'absent');
});

test('no class scheduled now → class control runs on its own; a class already live is reused but not ended by it', async () => {
  await schedule(120, 180); // later today
  assert.equal(await lifecycle.linkLiveSession({ courseId: course._id, teacherId: teacher._id }), null);
  const live = await schedule(-30, 30, { status: 'live', startedAt: new Date() });
  const linked = await lifecycle.linkLiveSession({ courseId: course._id, teacherId: teacher._id });
  assert.equal(linked, live.id);
  const after = await lifecycle.finish(linked, teacher._id, { averageEnergy: null, attentiveCount: 0, participantCount: 0, record: null });
  assert.equal(after.status, 'live'); // the teacher started it from Live Classes; they end it there
});

test('another teacher\'s class is never linked', async () => {
  const other = await User.create({ fullName: 'other', email: 'other@life.test', passwordHash: 'x' });
  await schedule(0, 60);
  assert.equal(await lifecycle.linkLiveSession({ courseId: course._id, teacherId: other._id }), null);
});
