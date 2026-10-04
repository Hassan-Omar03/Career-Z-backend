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
const TeacherEmployment = require('../src/models/TeacherEmployment');
const ParentChildLink = require('../src/models/ParentChildLink');
const HelpDeskTicket = require('../src/models/HelpDeskTicket');
const InstitutionEvent = require('../src/models/InstitutionEvent');
const HealthIncident = require('../src/models/HealthIncident');
const InstitutionEmployerPartnership = require('../src/models/InstitutionEmployerPartnership');
const PlacementReferral = require('../src/models/PlacementReferral');
const Job = require('../src/models/Job');
const LibraryBook = require('../src/models/LibraryBook');
const LibraryLoan = require('../src/models/LibraryLoan');

const ctrl = require('../src/controllers/institutionOps.controller');
const studentCtrl = require('../src/controllers/student.controller');
const parentCtrl = require('../src/controllers/parent.controller');
const employerCtrl = require('../src/controllers/institutionEmployer.controller');

let mongo, owner, staff, student, outsider, teacher, parent, institution;
const models = [
  User, Institution, StudentProfile, StudentInstitutionMembership, TeacherEmployment, ParentChildLink,
  HelpDeskTicket, InstitutionEvent, HealthIncident, InstitutionEmployerPartnership, PlacementReferral, Job,
  LibraryBook, LibraryLoan
];

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
  owner = await User.create({ fullName: 'Ops Owner', email: 'ops2-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  staff = await User.create({ fullName: 'Ops Staff', email: 'ops2-staff@test.local', passwordHash: 'x', roles: ['institution_staff'] });
  student = await User.create({ fullName: 'Ops Student', email: 'ops2-student@test.local', passwordHash: 'x', roles: ['student'] });
  outsider = await User.create({ fullName: 'Outsider', email: 'ops2-outsider@test.local', passwordHash: 'x', roles: ['student'] });
  teacher = await User.create({ fullName: 'Ops Teacher', email: 'ops2-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  parent = await User.create({ fullName: 'Ops Parent', email: 'ops2-parent@test.local', passwordHash: 'x', roles: ['parent'] });
  institution = await Institution.create({
    name: 'Ops Institution 2', slug: 'ops-institution-2', type: 'school', country: 'PK', owner: owner._id,
    verificationStatus: 'approved', staff: [{ user: staff._id, role: 'other', permissions: ['institution:ops:manage'] }]
  });
  await StudentInstitutionMembership.create({ student: student._id, institution: institution._id, status: 'active' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
});

// ---- Help Desk ----

test('an outsider with no relationship to the institution cannot raise a help desk ticket', async () => {
  const res = await invoke(ctrl.createTicket, { user: outsider, params: { id: institution._id.toString() }, body: { category: 'academic', subject: 'Test', description: 'Test issue' } });
  assert.equal(res.status, 403);
});

test('a student, teacher and parent of this institution can all raise a ticket', async () => {
  await TeacherEmployment.create({ institution: institution._id, teacher: teacher._id, offeredBy: owner._id, status: 'active' });
  await ParentChildLink.create({ parent: parent._id, student: student._id, status: 'approved', requestedBy: parent._id });

  for (const user of [student, teacher, parent]) {
    const res = await invoke(ctrl.createTicket, { user, params: { id: institution._id.toString() }, body: { category: 'academic', subject: 'Test', description: 'Test issue' } });
    assert.equal(res.status, 201, `${user.fullName} should be able to raise a ticket`);
    assert.match(res.body.data.ticketNumber, /^TKT-/);
  }
});

test('a ticket can only be assigned to the institution\'s own owner/staff, and the assignee is notified', async () => {
  const ticket = await HelpDeskTicket.create({ institution: institution._id, raisedBy: student._id, category: 'academic', subject: 'Test', description: 'Test issue' });

  const invalid = await invoke(ctrl.updateTicket, { user: owner, params: { ticketId: ticket._id.toString() }, body: { assignedTo: outsider._id.toString() } });
  assert.equal(invalid.status, 422);

  const valid = await invoke(ctrl.updateTicket, { user: owner, params: { ticketId: ticket._id.toString() }, body: { assignedTo: staff._id.toString() } });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.data.assignedTo.toString(), staff._id.toString());
});

// ---- Events & Activities ----

test('rsvp requires a real relationship to the institution, and can be withdrawn', async () => {
  const event = await InstitutionEvent.create({ institution: institution._id, title: 'Sports Day', type: 'sports_day', startDate: new Date(), createdBy: owner._id });

  const blocked = await invoke(ctrl.rsvpEvent, { user: outsider, params: { eventId: event._id.toString() } });
  assert.equal(blocked.status, 403);

  const ok1 = await invoke(ctrl.rsvpEvent, { user: student, params: { eventId: event._id.toString() } });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.body.data.rsvps.length, 1);

  const cancelled = await invoke(ctrl.cancelRsvp, { user: student, params: { eventId: event._id.toString() } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.rsvps.length, 0);
});

// ---- Medical & Health ----

test('a student can view their own health record (including vaccinations and incidents), which did not exist before', async () => {
  await StudentProfile.findOneAndUpdate(
    { user: student._id },
    { bloodGroup: 'O+', allergies: ['Peanuts'], vaccinations: [{ name: 'Hepatitis B', date: new Date(), notes: 'Dose 1' }] }
  );
  await HealthIncident.create({ institution: institution._id, student: student._id, description: 'Minor fall', severity: 'minor', recordedBy: owner._id });

  const res = await invoke(studentCtrl.getMyHealthRecord, { user: student });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.bloodGroup, 'O+');
  assert.equal(res.body.data.vaccinations.length, 1);
  assert.equal(res.body.data.incidents.length, 1);
});

test('a parent now sees vaccinations and incident history too, not just the four original fields', async () => {
  await StudentProfile.findOneAndUpdate(
    { user: student._id },
    { bloodGroup: 'A+', vaccinations: [{ name: 'MMR', date: new Date() }] }
  );
  await HealthIncident.create({ institution: institution._id, student: student._id, description: 'Fever', severity: 'moderate', recordedBy: owner._id });
  await ParentChildLink.create({ parent: parent._id, student: student._id, status: 'approved', requestedBy: parent._id, permissions: { viewHealth: true } });

  const res = await invoke(parentCtrl.getChildHealth, { user: parent, params: { studentId: student._id.toString() } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.vaccinations.length, 1);
  assert.equal(res.body.data.incidents.length, 1);
});

// ---- Placement Office ----

test('a partnership request raised by institution STAFF (not just the owner) is still correctly classified as institution-side, so only the employer can respond', async () => {
  const employer = await User.create({ fullName: 'Employer', email: 'ops2-employer@test.local', passwordHash: 'x', roles: ['employer'] });
  const created = await invoke(employerCtrl.requestPartnership, { user: staff, body: { institutionId: institution._id.toString(), employerEmail: employer.email } });
  assert.equal(created.status, 201);

  // The institution side (owner) must NOT be able to respond to its own staff's request.
  const selfRespond = await invoke(employerCtrl.respondPartnership, { user: owner, params: { id: created.body.data._id.toString() }, body: { decision: 'active' } });
  assert.equal(selfRespond.status, 403);

  // Only the employer can.
  const employerRespond = await invoke(employerCtrl.respondPartnership, { user: employer, params: { id: created.body.data._id.toString() }, body: { decision: 'active' } });
  assert.equal(employerRespond.status, 200);
  assert.equal(employerRespond.body.data.status, 'active');
});

test('an active partnership can be ended by either side, and a referral can be withdrawn before the student acts on it', async () => {
  const employer = await User.create({ fullName: 'Employer2', email: 'ops2-employer2@test.local', passwordHash: 'x', roles: ['employer'] });
  const partnership = await InstitutionEmployerPartnership.create({ institution: institution._id, employer: employer._id, requestedBy: owner._id, status: 'active' });

  const ended = await invoke(employerCtrl.endPartnership, { user: employer, params: { id: partnership._id.toString() } });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.data.status, 'ended');

  const job = await Job.create({ title: 'Intern', company: 'TestCo', postedBy: employer._id, description: 'desc', location: 'Remote', country: 'PK' });
  const referral = await PlacementReferral.create({ institution: institution._id, student: student._id, job: job._id, referredBy: owner._id });
  const declined = await invoke(employerCtrl.declineReferral, { user: owner, params: { id: referral._id.toString() } });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.data.status, 'declined');
});

// ---- Library (regression: a real test account got stuck on "You are not linked to an active
// institution" after being marked 'graduated' — viewing the library/loan history must not
// hard-require 'active' membership, only SOME real (non-withdrawn/rejected) relationship. ----

test('a graduated (non-"active") student can still view the library catalog and their own loan/fine history', async () => {
  await StudentInstitutionMembership.findOneAndUpdate({ student: student._id, institution: institution._id }, { status: 'graduated' });
  const book = await LibraryBook.create({ institution: institution._id, title: 'Physics 101', copies: 2, availableCopies: 1, addedBy: owner._id });
  await LibraryLoan.create({ institution: institution._id, book: book._id, borrower: student._id, dueDate: new Date(), fineAmount: 50, status: 'overdue', issuedBy: owner._id });

  const res = await invoke(ctrl.getMyLibrary, { user: student });
  assert.equal(res.status, 200, 'a graduated student is not locked out of their own library/fine history');
  assert.equal(res.body.data.books.length, 1);
  assert.equal(res.body.data.loans.length, 1);
  assert.equal(res.body.data.loans[0].fineAmount, 50);
});

test('a student with a withdrawn membership (never a real ongoing relationship) is still refused', async () => {
  await StudentInstitutionMembership.findOneAndUpdate({ student: student._id, institution: institution._id }, { status: 'withdrawn' });
  const res = await invoke(ctrl.getMyLibrary, { user: student });
  assert.equal(res.status, 404);
});
