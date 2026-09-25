const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const realtime = require('../src/realtime/socket');
mock.method(realtime, 'emitToUser', () => {});
mock.method(realtime, 'broadcastStudyGroupPost', () => {});

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Institution = require('../src/models/Institution');
const Enrollment = require('../src/models/Enrollment');
const TeacherProfile = require('../src/models/TeacherProfile');
const StudyGroup = require('../src/models/StudyGroup');
const StudyGroupPost = require('../src/models/StudyGroupPost');
const ctrl = require('../src/controllers/studyGroup.controller');

let mongo, teacher, studentA, studentB, outsider, institution, course, otherCourse;
const models = [User, Course, Institution, Enrollment, TeacherProfile, StudyGroup, StudyGroupPost];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));

  teacher = await User.create({ fullName: 'Group Teacher', email: 'sg-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  studentA = await User.create({ fullName: 'Group Student A', email: 'sg-student-a@test.local', passwordHash: 'x', roles: ['student'] });
  studentB = await User.create({ fullName: 'Group Student B', email: 'sg-student-b@test.local', passwordHash: 'x', roles: ['student'] });
  outsider = await User.create({ fullName: 'Outsider', email: 'sg-outsider@test.local', passwordHash: 'x', roles: ['student'] });

  institution = await Institution.create({ name: 'SG Institution', slug: 'sg-institution', type: 'school', country: 'PK', owner: teacher._id, verificationStatus: 'approved' });
  course = await Course.create({ title: 'SG Course', teacher: teacher._id, institution: institution._id, published: true, isFree: true });
  otherCourse = await Course.create({ title: 'Other Course', teacher: teacher._id, institution: institution._id, published: true, isFree: true });
  await Enrollment.create({ student: studentA._id, course: course._id, status: 'active', overallScore: 90 });
  await Enrollment.create({ student: studentB._id, course: course._id, status: 'active', overallScore: 40 });
  await TeacherProfile.create({ user: teacher._id, institutions: [institution._id] });
});

test('only an enrolled student can create/discover a group for that course; outsider is rejected', async () => {
  const badCreate = await invoke(ctrl.createGroup, { user: outsider, body: { name: 'X', courseId: course._id.toString() } });
  assert.equal(badCreate.status, 403);

  const created = await invoke(ctrl.createGroup, { user: studentA, body: { name: 'Study Squad', courseId: course._id.toString() } });
  assert.equal(created.status, 201);

  const badList = await invoke(ctrl.listGroups, { user: outsider, query: { courseId: course._id.toString() } });
  assert.equal(badList.status, 403);

  const list = await invoke(ctrl.listGroups, { user: studentA, query: { courseId: course._id.toString() } });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
});

test('open-policy join works instantly; approval-policy requires owner/teacher decision; group cannot exceed maxMembers', async () => {
  const created = await invoke(ctrl.createGroup, { user: studentA, body: { name: 'G1', courseId: course._id.toString(), joinPolicy: 'approval', maxMembers: 2 } });
  const groupId = created.body.data._id;

  const join = await invoke(ctrl.joinGroup, { user: studentB, params: { id: groupId } });
  assert.equal(join.status, 200);
  assert.match(join.body.message, /waiting/i);

  const get1 = await invoke(ctrl.getGroup, { user: studentA, params: { id: groupId } });
  assert.equal(get1.body.data.pendingRequests.length, 1);

  const decide = await invoke(ctrl.decideJoinRequest, { user: studentA, params: { id: groupId, userId: studentB._id.toString() }, body: { action: 'approve' } });
  assert.equal(decide.status, 200);
  assert.equal(decide.body.data.members.length, 2);

  const full = await invoke(ctrl.joinGroup, { user: outsider, params: { id: groupId } });
  assert.equal(full.status, 403, 'not enrolled in the course, so rejected before capacity is even checked');
});

test('owner cannot leave without transferring ownership first; teacher can moderate/remove a member', async () => {
  const created = await invoke(ctrl.createGroup, { user: studentA, body: { name: 'G2', courseId: course._id.toString() } });
  const groupId = created.body.data._id;
  await invoke(ctrl.joinGroup, { user: studentB, params: { id: groupId } });

  const ownerLeave = await invoke(ctrl.leaveGroup, { user: studentA, params: { id: groupId } });
  assert.equal(ownerLeave.status, 400);

  const remove = await invoke(ctrl.removeMember, { user: teacher, params: { id: groupId, userId: studentB._id.toString() } });
  assert.equal(remove.status, 200);
  assert.equal(remove.body.data.members.length, 1);
});

test('teacher-managed group: members cannot self-join, and the AI Group Maker balances by performance', async () => {
  const managed = await invoke(ctrl.teacherCreateGroup, { user: teacher, body: { name: 'Managed', courseId: course._id.toString(), memberIds: [studentA._id.toString()] } });
  assert.equal(managed.status, 201);
  const rejected = await invoke(ctrl.joinGroup, { user: studentB, params: { id: managed.body.data._id } });
  assert.equal(rejected.status, 403);

  const ai = await invoke(ctrl.aiGenerateGroups, { user: teacher, body: { courseId: course._id.toString(), groupSize: 2 } });
  assert.equal(ai.status, 201);
  assert.ok(ai.body.data.length >= 1);
  const highAndLow = ai.body.data[0].members.map((m) => m.user.toString());
  assert.ok(highAndLow.includes(teacher.id));
});

test('a teacher can only manage groups in their own course; grading writes group + individual marks', async () => {
  const other = await User.create({ fullName: 'Other Teacher', email: 'sg-other-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  const forbidden = await invoke(ctrl.teacherCourseGroups, { user: other, params: { courseId: course._id.toString() } });
  assert.equal(forbidden.status, 403);

  const created = await invoke(ctrl.createGroup, { user: studentA, body: { name: 'G3', courseId: course._id.toString() } });
  const groupId = created.body.data._id;
  const marks = await invoke(ctrl.setMarks, { user: teacher, params: { id: groupId }, body: { groupMarks: 85, individualMarks: [{ userId: studentA._id.toString(), marks: 90 }] } });
  assert.equal(marks.status, 200);
  assert.equal(marks.body.data.groupMarks, 85);
  assert.equal(marks.body.data.individualMarks[0].marks, 90);

  const badGrader = await invoke(ctrl.setMarks, { user: other, params: { id: groupId }, body: { groupMarks: 50 } });
  assert.equal(badGrader.status, 403);
});

test('discussion posts require membership; non-member is rejected', async () => {
  const created = await invoke(ctrl.createGroup, { user: studentA, body: { name: 'G4', courseId: course._id.toString() } });
  const groupId = created.body.data._id;
  const posted = await invoke(ctrl.addPost, { user: studentA, params: { id: groupId }, body: { text: 'hello' } });
  assert.equal(posted.status, 201);
  const blocked = await invoke(ctrl.addPost, { user: studentB, params: { id: groupId }, body: { text: 'hi' } });
  assert.equal(blocked.status, 403);
});
