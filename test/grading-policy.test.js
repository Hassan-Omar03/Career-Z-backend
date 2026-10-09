const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Result = require('../src/models/Result');
const StudentProfile = require('../src/models/StudentProfile');
const GradingPolicy = require('../src/models/GradingPolicy');
const ctrl = require('../src/controllers/gradingPolicy.controller');
const courseCtrl = require('../src/controllers/course.controller');
const { buildTranscript } = require('../src/services/certificate.service');
const { validatePolicy } = require('../src/services/grading.service');

const models = [User, Institution, Course, Enrollment, Result, StudentProfile, GradingPolicy];
let mongo, owner, staff, teacher, student, institution, course;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  [owner, staff, teacher, student] = await User.create(['owner', 'staff', 'teacher', 'student'].map((n) => ({ fullName: n, email: `${n}@grade.test`, passwordHash: 'x', roles: [n === 'teacher' ? 'teacher' : 'student'] })));
  institution = await Institution.create({ name: 'Uni', slug: 'uni-grade', type: 'university', country: 'PK', owner: owner._id, verificationStatus: 'approved', staff: [{ user: staff._id, role: 'staff', permissions: [] }] });
  course = await Course.create({ title: 'Physics', subject: 'Physics', teacher: teacher._id, institution: institution._id, creditHours: 3, academicTerm: 'Semester 1' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

const fiveScale = { gpaScaleMax: 5, passingPercent: 40, bands: [{ minPercent: 80, grade: 'A1', points: 5 }, { minPercent: 60, grade: 'B', points: 4 }, { minPercent: 40, grade: 'C', points: 2 }, { minPercent: 0, grade: 'U', points: 0 }] };

test('without a policy the default 4.0 scale applies', async () => {
  const policy = (await invoke(ctrl.getPolicy, { user: student, params: { id: institution.id } })).body.data;
  assert.equal(policy.isDefault, true);
  assert.equal(policy.gpaScaleMax, 4);
  await Result.create({ student: student._id, course: course._id, institution: institution._id, marksObtained: 85, totalMarks: 100, recordedBy: teacher._id });
  const t = await buildTranscript(student._id, institution._id);
  assert.equal(t.rows[0].grade, 'A'); assert.equal(t.cgpa, 4); assert.equal(t.gpaScaleMax, 4);
});

test('an institution scale drives transcript grades, points, pass/fail and the GPA scale', async () => {
  await invoke(ctrl.savePolicy, { user: owner, params: { id: institution.id }, body: fiveScale });
  await Result.create({ student: student._id, course: course._id, institution: institution._id, marksObtained: 45, totalMarks: 100, recordedBy: teacher._id });
  const t = await buildTranscript(student._id, institution._id);
  assert.equal(t.rows[0].grade, 'C');
  assert.equal(t.rows[0].gradePoints, 2);
  assert.equal(t.rows[0].passed, true); // 45% >= 40% passing
  assert.equal(t.gpaScaleMax, 5);
  assert.equal(t.cgpa, 2);
});

test('teacher-entered results without a grade get the institution grade automatically', async () => {
  await invoke(ctrl.savePolicy, { user: owner, params: { id: institution.id }, body: fiveScale });
  await invoke(courseCtrl.recordResult, { user: teacher, params: { id: course.id }, body: { student: student.id, marksObtained: 82, totalMarks: 100 } });
  assert.equal((await Result.findOne({ student: student._id })).grade, 'A1');
});

test('only the owner or staff with "grading:manage" can change the scale; reset restores the default', async () => {
  await assert.rejects(invoke(ctrl.savePolicy, { user: staff, params: { id: institution.id }, body: fiveScale }), { statusCode: 403 });
  await Institution.updateOne({ _id: institution._id, 'staff.user': staff._id }, { $set: { 'staff.$.permissions': ['grading:manage'] } });
  assert.equal((await invoke(ctrl.savePolicy, { user: staff, params: { id: institution.id }, body: fiveScale })).body.data.gpaScaleMax, 5);
  assert.equal((await invoke(ctrl.resetPolicy, { user: owner, params: { id: institution.id } })).body.data.isDefault, true);
});

test('invalid scales are rejected with a clear reason', () => {
  const bad = (patch, re) => assert.throws(() => validatePolicy({ ...fiveScale, ...patch }), re);
  bad({ gpaScaleMax: 7 }, /4, 5 or 10/);
  bad({ bands: [{ minPercent: 50, grade: 'P', points: 5 }, { minPercent: 10, grade: 'F', points: 0 }] }, /start at 0%/);
  bad({ bands: [{ minPercent: 50, grade: 'A', points: 2 }, { minPercent: 0, grade: 'B', points: 4 }] }, /lower band/);
  bad({ bands: [{ minPercent: 50, grade: 'A', points: 9 }, { minPercent: 0, grade: 'F', points: 0 }] }, /between 0 and 5/);
  bad({ bands: [{ minPercent: 50, grade: 'A', points: 5 }, { minPercent: 0, grade: 'a', points: 0 }] }, /unique/);
});
