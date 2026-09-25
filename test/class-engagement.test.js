const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Enrollment = require('../src/models/Enrollment');
const StudentProfile = require('../src/models/StudentProfile');
const TeacherProfile = require('../src/models/TeacherProfile');
const aqCtrl = require('../src/controllers/anonymousQuestion.controller');
const pollCtrl = require('../src/controllers/poll.controller');
const magCtrl = require('../src/controllers/magazine.controller');

let mongo, teacherA, teacherB, student, institution, courseA, courseB;
const models = [User, Course, Institution, ClassSection, Enrollment, StudentProfile, TeacherProfile];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const AnonymousQuestion = require('../src/models/AnonymousQuestion');
  const Poll = require('../src/models/Poll');
  const MagazineSubmission = require('../src/models/MagazineSubmission');
  await Promise.all([...models, AnonymousQuestion, Poll, MagazineSubmission].map((m) => m.init()));
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
  const AnonymousQuestion = require('../src/models/AnonymousQuestion');
  const Poll = require('../src/models/Poll');
  const MagazineSubmission = require('../src/models/MagazineSubmission');
  await Promise.all([AnonymousQuestion.deleteMany({}), Poll.deleteMany({}), MagazineSubmission.deleteMany({})]);

  teacherA = await User.create({ fullName: 'Teacher A', email: 'engage-teacher-a@test.local', passwordHash: 'x', roles: ['teacher'] });
  teacherB = await User.create({ fullName: 'Teacher B', email: 'engage-teacher-b@test.local', passwordHash: 'x', roles: ['teacher'] });
  student = await User.create({ fullName: 'Engage Student', email: 'engage-student@test.local', passwordHash: 'x', roles: ['student'] });
  institution = await Institution.create({ name: 'Engage Institution', slug: 'engage-institution', type: 'school', country: 'PK', owner: teacherA._id, verificationStatus: 'approved' });
  courseA = await Course.create({ title: 'Course A', teacher: teacherA._id, institution: institution._id, published: true, isFree: false });
  courseB = await Course.create({ title: 'Course B', teacher: teacherB._id, institution: institution._id, published: true, isFree: false });
  await Enrollment.create({ student: student._id, course: courseA._id, status: 'active' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
  // Both teachers need to actually be recognized as part of the institution (not just own a
  // course there) for the "are you part of this institution at all" gate to let them through —
  // otherwise a real "you don't teach this class" check can never be reached/tested.
  await TeacherProfile.create({ user: teacherA._id, institutions: [institution._id] });
  await TeacherProfile.create({ user: teacherB._id, institutions: [institution._id] });
});

test('anonymous question requires enrollment and only reaches the course-teaching teacher, never the other teacher', async () => {
  const AnonymousQuestion = require('../src/models/AnonymousQuestion');
  // Not enrolled in courseB -> rejected
  const badAsk = await invoke(aqCtrl.createQuestion, { user: student, body: { course: courseB._id.toString(), question: 'x' } });
  assert.equal(badAsk.status, 403);

  const ask = await invoke(aqCtrl.createQuestion, { user: student, body: { course: courseA._id.toString(), question: 'Why is the sky blue?' } });
  assert.equal(ask.status, 201);

  const teacherAView = await invoke(aqCtrl.institutionQuestions, { user: teacherA, query: { institutionId: institution._id.toString() } });
  assert.equal(teacherAView.body.data.length, 1);
  assert.equal(teacherAView.body.data[0].student, undefined, 'asker identity must never reach the teacher');

  const teacherBView = await invoke(aqCtrl.institutionQuestions, { user: teacherB, query: { institutionId: institution._id.toString() } });
  assert.equal(teacherBView.body.data.length, 0, 'a teacher must never see a question about a class they do not teach');

  const wrongAnswer = await invoke(aqCtrl.answerQuestion, { user: teacherB, params: { id: (await AnonymousQuestion.findOne({})).id }, body: { answer: 'nope' } });
  assert.equal(wrongAnswer.status, 403);
});

test('a course-scoped poll only reaches enrolled students, and percentages are correct', async () => {
  const created = await invoke(pollCtrl.createPoll, { user: teacherA, body: { course: courseA._id.toString(), question: 'Best time for class?', options: ['Morning', 'Evening'] } });
  assert.equal(created.status, 201);
  const pollId = created.body.data._id;

  // teacherB does not teach courseA -> cannot create a poll for it
  const forbidden = await invoke(pollCtrl.createPoll, { user: teacherB, body: { course: courseA._id.toString(), question: 'x', options: ['a', 'b'] } });
  assert.equal(forbidden.status, 403);

  const studentB = await User.create({ fullName: 'Not Enrolled', email: 'engage-not-enrolled@test.local', passwordHash: 'x', roles: ['student'] });
  const rejectedVote = await invoke(pollCtrl.vote, { user: studentB, params: { id: pollId }, body: { optionIndex: 0 } });
  assert.equal(rejectedVote.status, 403);

  const vote1 = await invoke(pollCtrl.vote, { user: student, params: { id: pollId }, body: { optionIndex: 0 } });
  assert.equal(vote1.status, 200);
  assert.equal(vote1.body.data.options[0].percent, 100);

  const dupVote = await invoke(pollCtrl.vote, { user: student, params: { id: pollId }, body: { optionIndex: 1 } });
  assert.equal(dupVote.status, 400);
});

test('institution-wide poll can only be created by the institution, not a teacher', async () => {
  // teacherA is this fixture's institution owner, so use teacherB — a real teacher here, but not
  // the owner — to actually test "a mere teacher can't broadcast institution-wide".
  const rejected = await invoke(pollCtrl.createPoll, { user: teacherB, body: { institution: institution._id.toString(), question: 'Campus-wide?', options: ['Yes', 'No'] } });
  assert.equal(rejected.status, 403);

  const owner = await User.findById(institution.owner);
  const allowed = await invoke(pollCtrl.createPoll, { user: owner, body: { institution: institution._id.toString(), question: 'Campus-wide?', options: ['Yes', 'No'] } });
  assert.equal(allowed.status, 201);
});

test('magazine: request changes lets the student resubmit, and a rejected/selected submission cannot', async () => {
  const submitted = await invoke(magCtrl.submit, { user: student, body: { title: 'My Poem', type: 'poetry', content: 'Roses are red' } });
  const id = submitted.body.data._id;
  // Need the student's primaryInstitution set for submit() to have worked; ensure it succeeded.
  assert.equal(submitted.status, 201);

  const changes = await invoke(magCtrl.review, { user: teacherA, params: { id }, body: { status: 'changes_requested', editorNotes: 'Add a second stanza' } });
  assert.equal(changes.status, 200);
  assert.equal(changes.body.data.status, 'changes_requested');

  const resub = await invoke(magCtrl.resubmit, { user: student, params: { id }, body: { title: 'My Poem', type: 'poetry', content: 'Roses are red, violets are blue' } });
  assert.equal(resub.status, 200);
  assert.equal(resub.body.data.status, 'submitted');

  const rejected = await invoke(magCtrl.review, { user: teacherA, params: { id }, body: { status: 'rejected' } });
  assert.equal(rejected.status, 200);

  const lateResub = await invoke(magCtrl.resubmit, { user: student, params: { id }, body: { title: 'x', content: 'y' } });
  assert.equal(lateResub.status, 400, 'a rejected submission is not awaiting changes and cannot be resubmitted');
});
