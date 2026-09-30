const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const ParentChildLink = require('../src/models/ParentChildLink');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Result = require('../src/models/Result');
const institutionCtrl = require('../src/controllers/institution.controller');
const teacherCtrl = require('../src/controllers/teacher.controller');

let mongo, owner, minorStudent, adultStudent, guardian, institution, teacher;
const models = [User, Institution, StudentProfile, StudentInstitutionMembership, ParentChildLink, Course, Enrollment, Result];

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
  owner = await User.create({ fullName: 'Owner', email: 'gc-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  minorStudent = await User.create({ fullName: 'Minor Student', email: 'gc-minor@test.local', passwordHash: 'x', roles: ['student'] });
  adultStudent = await User.create({ fullName: 'Adult Student', email: 'gc-adult@test.local', passwordHash: 'x', roles: ['student'] });
  guardian = await User.create({ fullName: 'Guardian', email: 'gc-guardian@test.local', passwordHash: 'x', roles: ['parent'] });
  teacher = await User.create({ fullName: 'Timeline Teacher', email: 'gc-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  institution = await Institution.create({ name: 'GC Institution', slug: 'gc-institution', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });

  const fifteenYearsAgo = new Date(Date.now() - 15 * 365.25 * 24 * 60 * 60 * 1000);
  const thirtyYearsAgo = new Date(Date.now() - 30 * 365.25 * 24 * 60 * 60 * 1000);
  await StudentProfile.create({ user: minorStudent._id, dateOfBirth: fifteenYearsAgo });
  await StudentProfile.create({ user: adultStudent._id, dateOfBirth: thirtyYearsAgo });
});

test('a minor cannot have their institution join approved without an approved, consenting guardian', async () => {
  const membership = await StudentInstitutionMembership.create({ student: minorStudent._id, institution: institution._id, status: 'pending', requestedAction: 'join' });
  const blocked = await invoke(institutionCtrl.reviewMembershipRequest, { user: owner, params: { id: institution._id.toString(), membershipId: membership._id.toString() }, body: { decision: 'approve' } });
  assert.equal(blocked.status, 422);

  await ParentChildLink.create({ parent: guardian._id, student: minorStudent._id, status: 'approved', requestedBy: guardian._id, permissions: { giveConsent: true } });
  const allowed = await invoke(institutionCtrl.reviewMembershipRequest, { user: owner, params: { id: institution._id.toString(), membershipId: membership._id.toString() }, body: { decision: 'approve' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.data.status, 'active');
});

test('an adult student needs no guardian to have their institution join approved', async () => {
  const membership = await StudentInstitutionMembership.create({ student: adultStudent._id, institution: institution._id, status: 'pending', requestedAction: 'join' });
  const allowed = await invoke(institutionCtrl.reviewMembershipRequest, { user: owner, params: { id: institution._id.toString(), membershipId: membership._id.toString() }, body: { decision: 'approve' } });
  assert.equal(allowed.status, 200);
});

test('a teacher only sees a consolidated timeline for a student enrolled in a course they teach', async () => {
  const course = await Course.create({ title: 'GC Course', teacher: teacher._id, institution: institution._id, published: true, isFree: true });
  const otherTeacher = await User.create({ fullName: 'Other Teacher', email: 'gc-other-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });

  const forbidden = await invoke(teacherCtrl.getStudentTimeline, { user: otherTeacher, params: { studentId: adultStudent._id.toString() } });
  assert.equal(forbidden.status, 403);

  await Enrollment.create({ student: adultStudent._id, course: course._id, status: 'active', overallScore: 82, progressPercent: 60 });
  await Result.create({ student: adultStudent._id, course: course._id, marksObtained: 45, totalMarks: 50, subject: 'Math', recordedBy: teacher._id });

  const allowed = await invoke(teacherCtrl.getStudentTimeline, { user: teacher, params: { studentId: adultStudent._id.toString() } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.data.courses.length, 1);
  assert.ok(allowed.body.data.timeline.some((t) => t.type === 'Result'));
});
