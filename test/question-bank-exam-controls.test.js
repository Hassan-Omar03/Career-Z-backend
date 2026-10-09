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
const TeacherProfile = require('../src/models/TeacherProfile');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Exam = require('../src/models/Exam');
const ExamSubmission = require('../src/models/ExamSubmission');
const Result = require('../src/models/Result');
const QuestionBankItem = require('../src/models/QuestionBankItem');
const bank = require('../src/controllers/questionBank.controller');
const courseCtrl = require('../src/controllers/course.controller');

const models = [User, Institution, TeacherProfile, Course, Enrollment, Exam, ExamSubmission, Result, QuestionBankItem];
let mongo, owner, teacher, otherTeacher, student, institution, otherInstitution, course;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  [owner, teacher, otherTeacher, student] = await User.create(['owner', 'teacher', 'other', 'student'].map((n) => ({ fullName: n, email: `${n}@qb.test`, passwordHash: 'x', roles: [n === 'student' ? 'student' : 'teacher'] })));
  institution = await Institution.create({ name: 'Uni', slug: 'uni-qb', type: 'university', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  otherInstitution = await Institution.create({ name: 'Other', slug: 'other-qb', type: 'school', country: 'PK', owner: otherTeacher._id, verificationStatus: 'approved' });
  await TeacherProfile.create({ user: teacher._id, institutions: [institution._id] });
  course = await Course.create({ title: 'Math', subject: 'Math', teacher: teacher._id, institution: institution._id, published: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
});

function invoke(handler, { user, params = {}, body = {}, query = {}, headers = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, query, headers }, res, reject)).catch(reject);
  });
}
const mcq = (n) => ({ text: `Q${n}`, type: 'mcq', options: [`${n}-a`, `${n}-b`, `${n}-c`, `${n}-d`], correctOption: 0, marks: n });

test('question bank: institution teachers share it; outsiders cannot see or use it', async () => {
  const saved = (await invoke(bank.createQuestion, { user: teacher, body: { ...mcq(1), institution: institution.id, subject: 'Math', difficulty: 'easy' } })).body.data;
  await invoke(bank.createQuestion, { user: teacher, body: { ...mcq(2), subject: 'Math' } }); // private (independent)
  assert.equal((await invoke(bank.listQuestions, { user: owner, query: {} })).body.data.length, 1); // owner sees institution bank only
  assert.equal((await invoke(bank.listQuestions, { user: teacher, query: { difficulty: 'easy' } })).body.data.length, 1);
  assert.equal((await invoke(bank.listQuestions, { user: teacher, query: {} })).body.data.length, 2);
  assert.equal((await invoke(bank.listQuestions, { user: otherTeacher, query: {} })).body.data.length, 0);
  await assert.rejects(invoke(bank.listQuestions, { user: otherTeacher, query: { institution: institution.id } }), { statusCode: 403 });
  await assert.rejects(invoke(bank.createQuestion, { user: otherTeacher, body: { ...mcq(3), institution: institution.id } }), { statusCode: 403 });
  await assert.rejects(invoke(bank.updateQuestion, { user: otherTeacher, params: { id: saved._id }, body: { text: 'hacked' } }), { statusCode: 403 });
  await assert.rejects(invoke(bank.createQuestion, { user: teacher, body: { text: 'bad', type: 'mcq', options: ['only one'], correctOption: 0, marks: 1 } }), { statusCode: 422 });
});

test('exams copy picked bank questions; a bank question from another institution is refused', async () => {
  const mine = (await invoke(bank.createQuestion, { user: teacher, body: { ...mcq(5), institution: institution.id } })).body.data;
  const foreign = await QuestionBankItem.create({ ...mcq(6), institution: otherInstitution._id, createdBy: otherTeacher._id });
  const exam = (await invoke(courseCtrl.createExam, { user: teacher, params: { id: course.id }, body: { title: 'Bank exam', academicSession: '2026', term: 'S1', questions: [mcq(1)], bankQuestionIds: [mine._id] } })).body.data;
  assert.deepEqual(exam.questions.map((q) => q.text), ['Q1', 'Q5']);
  assert.equal((await QuestionBankItem.findById(mine._id)).timesUsed, 1);
  await assert.rejects(invoke(courseCtrl.createExam, { user: teacher, params: { id: course.id }, body: { title: 'x', academicSession: '2026', term: 'S1', bankQuestionIds: [foreign._id] } }), { statusCode: 403 });
});

test('random subset + shuffled options per attempt; answers map back to the right question/option and grade on the attempt total', async () => {
  const exam = (await invoke(courseCtrl.createExam, { user: teacher, params: { id: course.id }, body: { title: 'Random', academicSession: '2026', term: 'S1', questions: [mcq(1), mcq(2), mcq(3), mcq(4), mcq(5)], shuffleQuestions: true, shuffleOptions: true, questionsPerAttempt: 3 } })).body.data;
  await Exam.updateOne({ _id: exam._id }, { $set: { published: true } });
  const started = (await invoke(courseCtrl.startExam, { user: student, params: { examId: exam._id }, headers: { 'user-agent': 'UA1' } })).body.data;
  assert.equal(started.exam.questions.length, 3);
  assert.equal(started.exam.questions.some((q) => 'correctOption' in q), false);
  // Student picks, for each shown question, the option whose text is the correct ("-a") one.
  const answers = started.exam.questions.map((q, i) => ({ questionIndex: i, selectedOption: q.options.findIndex((o) => o.endsWith('-a')) }));
  const again = (await invoke(courseCtrl.startExam, { user: student, params: { examId: exam._id }, headers: { 'user-agent': 'UA1' } })).body.data;
  assert.deepEqual(again.exam.questions.map((q) => q.text), started.exam.questions.map((q) => q.text)); // resume = same paper
  await invoke(courseCtrl.submitExam, { user: student, params: { examId: exam._id }, body: { answers }, headers: { 'user-agent': 'UA1' } });
  const attempt = await ExamSubmission.findOne({ exam: exam._id });
  assert.equal(attempt.answers.length, 3);
  assert.ok(attempt.answers.every((a) => a.selectedOption === 0)); // all mapped back to the original correct option
  const shownTexts = started.exam.questions.map((q) => q.text).sort();
  assert.deepEqual(attempt.answers.map((a) => `Q${a.questionIndex + 1}`).sort(), shownTexts);
  const manualMarks = attempt.answers.map((a) => ({ questionIndex: a.questionIndex, marks: a.questionIndex + 1 }));
  await invoke(courseCtrl.gradeExamSubmission, { user: teacher, params: { submissionId: attempt._id }, body: { manualMarks, grade: 'A' } });
  const result = await Result.findOne({ exam: exam._id });
  const expectedTotal = attempt.answers.reduce((s, a) => s + a.questionIndex + 1, 0);
  assert.equal(result.totalMarks, expectedTotal);
  assert.equal(result.marksObtained, expectedTotal);
});

test('integrity events: focus loss flags after the threshold, paste flags at once, other students cannot log on your attempt', async () => {
  const exam = (await invoke(courseCtrl.createExam, { user: teacher, params: { id: course.id }, body: { title: 'Secure', academicSession: '2026', term: 'S1', questions: [mcq(1), mcq(2)], flagThreshold: 2 } })).body.data;
  await Exam.updateOne({ _id: exam._id }, { $set: { published: true } });
  const { attempt } = (await invoke(courseCtrl.startExam, { user: student, params: { examId: exam._id } })).body.data;
  await invoke(courseCtrl.recordExamEvent, { user: student, params: { attemptId: attempt._id }, body: { type: 'tab_hidden' } });
  assert.equal((await ExamSubmission.findById(attempt._id)).flagged, false);
  await invoke(courseCtrl.recordExamEvent, { user: student, params: { attemptId: attempt._id }, body: { type: 'window_blur' } });
  assert.equal((await ExamSubmission.findById(attempt._id)).flagged, true);
  await assert.rejects(invoke(courseCtrl.recordExamEvent, { user: student, params: { attemptId: attempt._id }, body: { type: 'made_up' } }), { statusCode: 422 });
  await assert.rejects(invoke(courseCtrl.recordExamEvent, { user: otherTeacher, params: { attemptId: attempt._id }, body: { type: 'paste' } }), { statusCode: 404 });
});

test('submitting from a different device than the attempt started on is logged and flagged', async () => {
  const exam = (await invoke(courseCtrl.createExam, { user: teacher, params: { id: course.id }, body: { title: 'Device', academicSession: '2026', term: 'S1', questions: [mcq(1)] } })).body.data;
  await Exam.updateOne({ _id: exam._id }, { $set: { published: true } });
  await invoke(courseCtrl.startExam, { user: student, params: { examId: exam._id }, headers: { 'user-agent': 'Laptop' } });
  await invoke(courseCtrl.submitExam, { user: student, params: { examId: exam._id }, body: { answers: [{ questionIndex: 0, selectedOption: 1 }] }, headers: { 'user-agent': 'Phone' } });
  const attempt = await ExamSubmission.findOne({ exam: exam._id });
  assert.equal(attempt.flagged, true);
  assert.deepEqual(attempt.securityEvents.map((e) => e.type), ['device_changed']);
});
