// Permanent, committed regression coverage for this session's relationship-flow additions
// (previously only verified with throwaway scripts that were deleted after running — this is
// the saved version so `npm test` actually re-checks them going forward).
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.PADDLE_API_KEY = 'test-key';
process.env.PADDLE_WEBHOOK_SECRET = 'test-paddle-rel';

const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyMany', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const TeacherProfile = require('../src/models/TeacherProfile');
const TeacherEmployment = require('../src/models/TeacherEmployment');
const TeacherStudentLink = require('../src/models/TeacherStudentLink');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const ParentChildLink = require('../src/models/ParentChildLink');
const Vehicle = require('../src/models/Vehicle');
const TransportJourney = require('../src/models/TransportJourney');
const TransportLocationPing = require('../src/models/TransportLocationPing');
const TransportBoardingEvent = require('../src/models/TransportBoardingEvent');
const ParentTeacherMeeting = require('../src/models/ParentTeacherMeeting');
const PtmEscalation = require('../src/models/PtmEscalation');
const InstitutionEmployerPartnership = require('../src/models/InstitutionEmployerPartnership');
const PlacementReferral = require('../src/models/PlacementReferral');
const Job = require('../src/models/Job');
const JobApplication = require('../src/models/JobApplication');

const institutionMembership = require('../src/utils/institutionMembership');
const teacherEmploymentCtrl = require('../src/controllers/teacherEmployment.controller');
const teacherStudentLinkCtrl = require('../src/controllers/teacherStudentLink.controller');
const transportCtrl = require('../src/controllers/transportTracking.controller');
const ptmCtrl = require('../src/controllers/ptm.controller');
const parentCtrl = require('../src/controllers/parent.controller');
const institutionEmployerCtrl = require('../src/controllers/institutionEmployer.controller');

const ALL_MODELS = [
  User, Institution, StudentProfile, StudentInstitutionMembership, TeacherProfile, TeacherEmployment,
  TeacherStudentLink, Course, Enrollment, ParentChildLink, Vehicle, TransportJourney, TransportLocationPing,
  TransportBoardingEvent, ParentTeacherMeeting, PtmEscalation, InstitutionEmployerPartnership, PlacementReferral,
  Job, JobApplication
];

let database;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(ALL_MODELS.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => { await Promise.all(ALL_MODELS.map((m) => m.deleteMany({}))); });

function invoke(handler, { params = {}, user, body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ params, user, body, query }, res, reject)).catch(reject);
  });
}
async function mkUser(fullName, email, roles, extra = {}) {
  return User.create({ fullName, email, passwordHash: 'unused', roles, emailVerified: true, ...extra });
}

// ---------------- Multi-institution enrollment + transfer history ----------------
test('joining a second institution does not overwrite the first (real simultaneous membership)', async () => {
  const owner = await mkUser('Owner', 'owner@rel.test', ['institution_owner']);
  const student = await mkUser('Student', 'student@rel.test', ['student']);
  const instA = await Institution.create({ owner: owner._id, name: 'A', slug: 'a-' + Date.now(), type: 'school', country: 'PK' });
  const instB = await Institution.create({ owner: owner._id, name: 'B', slug: 'b-' + Date.now(), type: 'school', country: 'PK' });

  await institutionMembership.recordJoin(student._id, instA._id);
  await institutionMembership.recordJoin(student._id, instB._id);
  let profile = await StudentProfile.findOne({ user: student._id });
  assert.equal(profile.primaryInstitution.toString(), instA._id.toString());
  assert.equal(await StudentInstitutionMembership.countDocuments({ student: student._id }), 2);

  await institutionMembership.recordLeave(student._id, instA._id, 'transferred', 'moved');
  profile = await StudentProfile.findOne({ user: student._id });
  assert.equal(profile.primaryInstitution.toString(), instB._id.toString(), 'primary auto-promotes after leaving');
  const membershipA = await StudentInstitutionMembership.findOne({ student: student._id, institution: instA._id });
  assert.equal(membershipA.status, 'transferred');
  assert.ok(membershipA.leftAt);
});

// ---------------- Teacher employment lifecycle ----------------
test('a teacher offer only touches institution staff once accepted, and resignation cleans up', async () => {
  const owner = await mkUser('Owner', 'owner2@rel.test', ['institution_owner']);
  const teacher = await mkUser('Teacher', 'teacher@rel.test', ['teacher']);
  const institution = await Institution.create({ owner: owner._id, name: 'Emp Inst', slug: 'emp-' + Date.now(), type: 'school', country: 'PK', verificationStatus: 'approved' });

  const offerRes = await invoke(teacherEmploymentCtrl.createOffer, { params: { id: institution.id }, user: owner, body: { teacherUserId: teacher.id, role: 'teacher' } });
  assert.equal(offerRes.body.data.status, 'offered');
  assert.equal((await Institution.findById(institution._id)).staff.length, 0);

  await invoke(teacherEmploymentCtrl.respondToOffer, { params: { id: offerRes.body.data._id }, user: teacher, body: { decision: 'accepted' } });
  assert.equal((await Institution.findById(institution._id)).staff.length, 1);

  await invoke(teacherEmploymentCtrl.resign, { params: { id: offerRes.body.data._id }, user: teacher, body: { reason: 'test' } });
  assert.equal((await Institution.findById(institution._id)).staff.length, 0);
  const employment = await TeacherEmployment.findById(offerRes.body.data._id);
  assert.equal(employment.status, 'resigned');
});

// ---------------- Independent Teacher Enrollment ----------------
test('independent tutoring: never enrolls before consent, minors need guardian approval', async () => {
  const teacher = await mkUser('Indie', 'indie@rel.test', ['teacher']);
  await TeacherProfile.create({ user: teacher._id, independent: true });
  const minor = await mkUser('Minor', 'minor@rel.test', ['student']);
  await StudentProfile.create({ user: minor._id, dateOfBirth: new Date(Date.now() - 15 * 365.25 * 24 * 60 * 60 * 1000) });
  const guardian = await mkUser('Guardian', 'guardian@rel.test', ['parent']);
  await ParentChildLink.create({ parent: guardian._id, student: minor._id, relationship: 'mother', status: 'approved', requestedBy: guardian._id });
  const course = await Course.create({ title: 'Tutoring', subject: 'Math', teacher: teacher._id, isFree: true, published: true, institution: null });

  const invite = await invoke(teacherStudentLinkCtrl.inviteStudent, { user: teacher, body: { studentEmail: minor.email, courseId: course.id } });
  assert.equal(invite.body.data.requiresGuardianApproval, true);
  await invoke(teacherStudentLinkCtrl.respondToInvite, { params: { id: invite.body.data._id }, user: minor, body: { decision: 'accepted' } });
  assert.equal(await Enrollment.countDocuments({}), 0, 'no enrollment until guardian approves');

  await invoke(teacherStudentLinkCtrl.guardianApprove, { params: { id: invite.body.data._id }, user: guardian, body: { approved: true } });
  assert.equal(await Enrollment.countDocuments({ student: minor._id, course: course._id }), 1);
});

// ---------------- Parent Safety / Live Transport ----------------
test('transport location is only ever visible during an in-progress journey, scoped to assigned children', async () => {
  const owner = await mkUser('Owner', 'owner3@rel.test', ['institution_owner']);
  const institution = await Institution.create({ owner: owner._id, name: 'Transport Inst', slug: 'tr-' + Date.now(), type: 'school', country: 'PK' });
  const student = await mkUser('TStudent', 'tstudent@rel.test', ['student']);
  const parent = await mkUser('TParent', 'tparent@rel.test', ['parent']);
  const stranger = await mkUser('Stranger', 'stranger@rel.test', ['parent']);
  await ParentChildLink.create({ parent: parent._id, student: student._id, relationship: 'father', status: 'approved', requestedBy: parent._id });
  const vehicle = await Vehicle.create({ institution: institution._id, vehicleNumber: 'V1', addedBy: owner._id, assignedStudents: [student._id] });

  const journeyRes = await invoke(transportCtrl.startJourney, { params: { vehicleId: vehicle.id }, user: owner });
  const journeyId = journeyRes.body.data._id;

  await assert.rejects(invoke(transportCtrl.getJourneyStatus, { params: { id: journeyId }, user: stranger }), { statusCode: 403 });
  const okRes = await invoke(transportCtrl.getJourneyStatus, { params: { id: journeyId }, user: parent });
  assert.equal(okRes.body.data.journey._id.toString(), journeyId.toString());

  await invoke(transportCtrl.endJourney, { params: { id: journeyId }, user: owner });
  await assert.rejects(invoke(transportCtrl.postPing, { params: { id: journeyId }, user: owner, body: { lat: 1, lng: 1 } }), { statusCode: 400 });
});

// ---------------- PTM: no-show escalation ----------------
test('3 no-shows in the window automatically opens an institution escalation flag', async () => {
  const owner = await mkUser('Owner', 'owner4@rel.test', ['institution_owner']);
  const institution = await Institution.create({ owner: owner._id, name: 'PTM Inst', slug: 'ptm-' + Date.now(), type: 'school', country: 'PK' });
  const teacher = await mkUser('PTMTeacher', 'ptmteacher@rel.test', ['teacher']);
  const parent = await mkUser('PTMParent', 'ptmparent@rel.test', ['parent']);
  const student = await mkUser('PTMStudent', 'ptmstudent@rel.test', ['student']);

  for (let i = 0; i < 3; i++) {
    const m = await ParentTeacherMeeting.create({ parent: parent._id, teacher: teacher._id, student: student._id, institution: institution._id, requestedDate: new Date(), confirmedDate: new Date(), status: 'confirmed' });
    await invoke(ptmCtrl.markNoShow, { params: { id: m.id }, user: teacher });
  }
  const escalations = await PtmEscalation.find({ parent: parent._id, institution: institution._id });
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].meetings.length, 3);
});

// ---------------- Institution <-> Employer ----------------
test('a referral can only be created with an active partnership, and never auto-applies', async () => {
  const owner = await mkUser('Owner', 'owner5@rel.test', ['institution_owner']);
  const institution = await Institution.create({ owner: owner._id, name: 'Placement Inst', slug: 'pl-' + Date.now(), type: 'school', country: 'PK' });
  const employer = await mkUser('Employer', 'employer@rel.test', ['employer']);
  const student = await mkUser('Grad', 'grad@rel.test', ['student']);
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
  const job = await Job.create({ postedBy: employer._id, title: 'Junior Dev', company: 'Acme', country: 'PK' });

  await assert.rejects(
    invoke(institutionEmployerCtrl.createReferral, { user: owner, body: { studentId: student.id, jobId: job.id } }),
    { statusCode: 403 }
  );

  const partnershipRes = await invoke(institutionEmployerCtrl.requestPartnership, { user: owner, body: { institutionId: institution.id, employerEmail: employer.email } });
  await invoke(institutionEmployerCtrl.respondPartnership, { params: { id: partnershipRes.body.data._id }, user: employer, body: { decision: 'active' } });

  const referralRes = await invoke(institutionEmployerCtrl.createReferral, { user: owner, body: { studentId: student.id, jobId: job.id } });
  assert.equal(referralRes.body.data.status, 'referred');
  assert.equal(await JobApplication.countDocuments({}), 0, 'referral alone never creates an application');

  await invoke(institutionEmployerCtrl.applyViaReferral, { params: { id: referralRes.body.data._id }, user: student });
  assert.equal(await JobApplication.countDocuments({ applicant: student._id, job: job._id }), 1);
});

// ---------------- Guardian permission granularity ----------------
test('a student can restrict a specific guardian\'s fee-payment permission', async () => {
  const parent = await mkUser('GParent', 'gparent@rel.test', ['parent']);
  const student = await mkUser('GStudent', 'gstudent@rel.test', ['student']);
  const link = await ParentChildLink.create({ parent: parent._id, student: student._id, relationship: 'father', status: 'approved', requestedBy: parent._id, approvedAt: new Date() });

  await invoke(parentCtrl.updateLinkPermissions, { params: { id: link.id }, user: student, body: { payFees: false } });
  const updated = await ParentChildLink.findById(link._id);
  assert.equal(updated.permissions.payFees, false);

  await assert.rejects(
    invoke(parentCtrl.payChildFee, { params: { studentId: student.id, feeId: new mongoose.Types.ObjectId().toString() }, user: parent, body: { paymentMethod: 'cash' } }),
    { statusCode: 403 }
  );
});

test('a sponsor link defaults to no health access, and cannot be granted by anyone but the student', async () => {
  const sponsor = await mkUser('Sponsor', 'sponsor@rel.test', ['parent']);
  const student = await mkUser('SStudent', 'sstudent@rel.test', ['student']);
  const link = await ParentChildLink.create({ parent: sponsor._id, student: student._id, relationship: 'sponsor', status: 'pending', requestedBy: sponsor._id });

  await invoke(parentCtrl.respondToLink, { params: { id: link.id }, user: student, body: { decision: 'approved' } });
  const approved = await ParentChildLink.findById(link._id);
  assert.equal(approved.permissions.viewHealth, false);

  await assert.rejects(
    invoke(parentCtrl.getChildHealth, { params: { studentId: student.id }, user: sponsor }),
    { statusCode: 403 }
  );
  await assert.rejects(
    invoke(parentCtrl.updateLinkPermissions, { params: { id: link.id }, user: sponsor, body: { viewHealth: true } }),
    { statusCode: 403 },
    'only the student can adjust their own guardians\' permissions'
  );
});
