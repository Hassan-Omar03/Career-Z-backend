const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notifyMany', async () => []);
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const StudentProfile = require('../src/models/StudentProfile');
const ctrl = require('../src/controllers/liveClass.controller');
const { enrollSectionStudents, enrollStudentInSection } = require('../src/utils/sectionEnrollment');

let mongo, seq = 0;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}
const person = (role) => { seq += 1; return User.create({ fullName: role + seq, email: role + seq + '@live.test', passwordHash: 'x', roles: [role] }); };
const times = () => ({ scheduledStart: new Date(Date.now() - 60000), scheduledEnd: new Date(Date.now() + 3600000) });
async function school() {
  const owner = await person('institution_owner'), teacher = await person('teacher'), student = await person('student');
  seq += 1;
  const institution = await Institution.create({ owner: owner._id, name: 'School ' + seq, slug: 'school-' + seq, type: 'school', country: 'PK', verificationStatus: 'approved' });
  const section = await ClassSection.create({ institution: institution._id, name: 'A', academicYear: '2026' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id, classSection: section._id });
  return { teacher, student, institution, section };
}

test('a course published after admission reaches the students already in that class, who can join its live class', async () => {
  const { teacher, student, institution, section } = await school();
  const course = await Course.create({ institution: institution._id, classSection: section._id, teacher: teacher._id, title: 'A Level', published: true });
  assert.equal(await Enrollment.countDocuments({ course: course._id }), 0);
  const made = await invoke(ctrl.schedule, { user: teacher, body: { institution: institution._id, course: course._id, title: 'Live', ...times() } });
  assert.equal(made.status, 201);
  assert.equal(await Enrollment.countDocuments({ course: course._id, student: student._id }), 1);
  const id = made.body.data._id;
  await invoke(ctrl.start, { user: teacher, params: { id } });
  const listed = await invoke(ctrl.studentList, { user: student });
  assert.equal(listed.body.data.length, 1);
  assert.equal((await invoke(ctrl.join, { user: student, params: { id } })).status, 200);
});

test('enrollment skips graduated students, keeps a dropped choice, and covers a student placed in the class later', async () => {
  const { teacher, student, institution, section } = await school();
  const gone = await person('student');
  await StudentProfile.create({ user: gone._id, primaryInstitution: institution._id, classSection: section._id, status: 'graduated' });
  const course = await Course.create({ institution: institution._id, classSection: section._id, teacher: teacher._id, title: 'Physics', published: true });
  assert.equal(await enrollSectionStudents(course), 1);
  assert.equal(await Enrollment.countDocuments({ course: course._id, student: gone._id }), 0);
  await Enrollment.updateOne({ course: course._id, student: student._id }, { status: 'dropped' });
  await enrollSectionStudents(course);
  assert.equal((await Enrollment.findOne({ course: course._id, student: student._id })).status, 'dropped');
  const late = await person('student');
  await enrollStudentInSection(late._id, section._id);
  assert.equal(await Enrollment.countDocuments({ course: course._id, student: late._id }), 1);
  const draft = await Course.create({ institution: institution._id, classSection: section._id, teacher: teacher._id, title: 'Draft' });
  assert.equal(await enrollSectionStudents(draft), 0);
});

test('a teacher runs a live class on their own course; an unpublished course and another teacher are refused', async () => {
  const teacher = await person('teacher'), other = await person('teacher'), student = await person('student');
  const course = await Course.create({ teacher: teacher._id, title: 'My course', isFree: true, published: true });
  await Enrollment.create({ student: student._id, course: course._id });
  await assert.rejects(invoke(ctrl.schedule, { user: other, body: { course: course._id, title: 'x', ...times() } }), /assigned to this course/);
  const draft = await Course.create({ teacher: teacher._id, title: 'Draft', isFree: true });
  await assert.rejects(invoke(ctrl.schedule, { user: teacher, body: { course: draft._id, title: 'x', ...times() } }), /Publish this course/);
  const made = await invoke(ctrl.schedule, { user: teacher, body: { course: course._id, title: 'Own class', ...times() } });
  assert.equal(made.status, 201);
  const id = made.body.data._id;
  assert.equal((await invoke(ctrl.start, { user: teacher, params: { id } })).status, 200);
  assert.equal((await invoke(ctrl.join, { user: student, params: { id } })).status, 200);
  assert.equal((await invoke(ctrl.end, { user: teacher, params: { id } })).status, 200);
});
