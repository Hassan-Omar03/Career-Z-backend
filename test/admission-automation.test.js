const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const InstitutionProgram = require('../src/models/InstitutionProgram');
const InstitutionApplication = require('../src/models/InstitutionApplication');
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Fee = require('../src/models/Fee');
const appCtrl = require('../src/controllers/institutionApplication.controller');

let mongo, owner, applicant, institution, section, program, course1, course2, unpublishedCourse;
const models = [User, Institution, ClassSection, InstitutionProgram, InstitutionApplication, StudentProfile, StudentInstitutionMembership, Course, Enrollment, Fee];

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
  owner = await User.create({ fullName: 'Admission Owner', email: 'adm-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  applicant = await User.create({ fullName: 'Admission Applicant', email: 'adm-applicant@test.local', passwordHash: 'x', roles: ['student'], emailVerified: true });
  institution = await Institution.create({ name: 'Admission Institution', slug: 'admission-institution', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  section = await ClassSection.create({ institution: institution._id, name: 'Grade 9 - A', academicYear: '2026' });
  program = await InstitutionProgram.create({ institution: institution._id, name: 'Grade 9', department: 'Science', classSection: section._id, totalTuitionFee: 50000, currency: 'PKR', createdBy: owner._id });
  course1 = await Course.create({ title: 'Physics', teacher: owner._id, institution: institution._id, classSection: section._id, published: true, isFree: true });
  course2 = await Course.create({ title: 'Chemistry', teacher: owner._id, institution: institution._id, classSection: section._id, published: true, isFree: true });
  unpublishedCourse = await Course.create({ title: 'Draft Course', teacher: owner._id, institution: institution._id, classSection: section._id, published: false, isFree: true });
});

test('accepting an admission application automatically creates membership, sets the student profile, enrolls every published class course, and generates the fee plan', async () => {
  const application = await InstitutionApplication.create({
    institution: institution._id, applicant: applicant._id, program: program.name, status: 'submitted', submittedAt: new Date()
  });

  const result = await invoke(appCtrl.acceptAndEnroll, { user: owner, params: { id: application._id.toString() } });
  assert.equal(result.status, 200, result.body.message);
  assert.equal(result.body.data.status, 'accepted');

  const membership = await StudentInstitutionMembership.findOne({ student: applicant._id, institution: institution._id });
  assert.ok(membership, 'membership was auto-created');
  assert.equal(membership.status, 'active');

  const profile = await StudentProfile.findOne({ user: applicant._id });
  assert.ok(profile, 'student profile was auto-created');
  assert.equal(String(profile.classSection), String(section._id));
  assert.equal(profile.program, program.name);

  const enrollments = await Enrollment.find({ student: applicant._id });
  const enrolledCourseIds = enrollments.map((e) => e.course.toString()).sort();
  assert.deepEqual(enrolledCourseIds, [course1._id.toString(), course2._id.toString()].sort(), 'auto-enrolled in every published class course, and only those');
  assert.ok(!enrolledCourseIds.includes(unpublishedCourse._id.toString()), 'an unpublished course is never auto-enrolled');

  const fees = await Fee.find({ student: applicant._id, institution: institution._id });
  assert.ok(fees.length > 0, 'a fee plan was auto-generated from the program');
});

test('a mid-year transfer applicant (already primary elsewhere) is still auto-enrolled in the new institution\'s courses', async () => {
  const otherInstitution = await Institution.create({ name: 'Other Institution', slug: 'other-institution-adm', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  await StudentInstitutionMembership.create({ student: applicant._id, institution: otherInstitution._id, status: 'active', isPrimary: true, joinedAt: new Date() });
  await StudentProfile.create({ user: applicant._id, primaryInstitution: otherInstitution._id });

  const application = await InstitutionApplication.create({
    institution: institution._id, applicant: applicant._id, program: program.name, status: 'submitted', submittedAt: new Date()
  });
  const result = await invoke(appCtrl.acceptAndEnroll, { user: owner, params: { id: application._id.toString() } });
  assert.equal(result.status, 200, result.body.message);

  const enrollments = await Enrollment.find({ student: applicant._id, course: { $in: [course1._id, course2._id] } });
  assert.equal(enrollments.length, 2, 'course auto-enrollment does not depend on this being the primary institution');
});
