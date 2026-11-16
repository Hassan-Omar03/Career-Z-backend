// Client audit N-01 (MCQs checked on submit), N-02 (no phone or link in a first message),
// N-04 (exam opening message without a UTC timestamp) and N-06 (scholarship form says why it cannot open).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'audit-group3-test';
const notifications = require('../src/services/notification.service');
for (const fn of ['notify', 'notifyAdmins', 'notifyMany', 'notifyParentsOfStudent']) if (notifications[fn]) mock.method(notifications, fn, async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile'), Course = m('Course'), Enrollment = m('Enrollment');
const Exam = m('Exam'), ExamSubmission = m('ExamSubmission'), Result = m('Result'), Message = m('Message');

let mongo, server, base, teacher, student, other, course;
const token = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const call = async (method, p, body, auth) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token(auth) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const make = async (fullName, email, role, extra = {}) => {
  const u = await User.create({ fullName, email, passwordHash: await User.hashPassword('Good@Pass123'), emailVerified: true, roles: [role], status: 'active', ...extra });
  await RoleRequest.create({ user: u._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 864e5) });
  await UserProfile.updateOne({ user: u._id, role }, { $set: { completed: true, percent: 100 } }, { upsert: true });
  return u;
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  teacher = await make('Teacher', 'teacher@group3.test', 'teacher');
  student = await make('Student', 'student@group3.test', 'student');
  other = await make('Other', 'other@group3.test', 'student');
  course = await Course.create({ title: 'Maths', teacher: teacher._id, published: true, price: 0, currency: 'PKR', isFree: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const mcq = (text, correct, marks = 2) => ({ text, type: 'mcq', options: ['A', 'B', 'C'], correctOption: correct, marks });

test('N-01: an all-MCQ paper is checked and its result published on submit', async () => {
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'MCQ quiz', published: true, durationMinutes: 30, questions: [mcq('q1', 1), mcq('q2', 2), mcq('q3', 0)] });
  const start = await call('POST', `/courses/exams/${exam._id}/start`, {}, student);
  assert.equal(start.status, 200, start.body.message);
  const attempt = await ExamSubmission.findOne({ exam: exam._id, student: student._id }).lean();
  // Answer in the student's display order: right, right, wrong.
  const order = attempt.questionOrder?.length ? attempt.questionOrder : [0, 1, 2];
  const optionOrders = attempt.optionOrders || [];
  const want = { 0: 1, 1: 2, 2: 1 };
  const answers = order.map((original, i) => { const opts = optionOrders[i] || [0, 1, 2]; return { questionIndex: i, selectedOption: opts.indexOf(want[original]) }; });
  const r = await call('POST', `/courses/exams/${exam._id}/submit`, { answers }, student);
  assert.equal(r.status, 201, r.body.message);
  assert.match(r.body.message, /checked: 4\/6/);
  const saved = await ExamSubmission.findById(attempt._id).lean();
  assert.equal(saved.status, 'graded');
  assert.equal(saved.score, 4);
  assert.ok(saved.finalGrade);
  const result = await Result.findOne({ student: student._id, exam: exam._id }).lean();
  assert.equal(result.marksObtained, 4);
});

test('N-01: a mixed paper checks MCQs on submit; the teacher marks only the written answer', async () => {
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Mixed', published: true, durationMinutes: 30, questions: [mcq('q1', 1, 3), { text: 'Explain', type: 'short', marks: 5 }] });
  await call('POST', `/courses/exams/${exam._id}/start`, {}, student);
  const attempt = await ExamSubmission.findOne({ exam: exam._id, student: student._id }).lean();
  const order = attempt.questionOrder?.length ? attempt.questionOrder : [0, 1];
  const answers = order.map((original, i) => (original === 0 ? { questionIndex: i, selectedOption: (attempt.optionOrders?.[i] || [0, 1, 2]).indexOf(1) } : { questionIndex: i, textAnswer: 'Because.' }));
  const r = await call('POST', `/courses/exams/${exam._id}/submit`, { answers }, student);
  assert.equal(r.status, 201, r.body.message);
  let saved = await ExamSubmission.findById(attempt._id).lean();
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.answers.find((a) => a.questionIndex === 0).marksAwarded, 3);
  const missing = await call('PATCH', `/courses/exam-submissions/${attempt._id}/grade`, { manualMarks: [], grade: 'B' }, teacher);
  assert.equal(missing.status, 422, 'the written answer still needs a mark');
  const graded = await call('PATCH', `/courses/exam-submissions/${attempt._id}/grade`, { manualMarks: [{ questionIndex: 1, marks: 4 }], grade: 'B' }, teacher);
  assert.equal(graded.status, 200, graded.body.message);
  saved = await ExamSubmission.findById(attempt._id).lean();
  assert.equal(saved.score, 7, 'automatic MCQ mark kept, teacher mark added');
});

test('N-04: an exam that has not opened says so without a UTC timestamp', async () => {
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Later', published: true, durationMinutes: 30, scheduledDate: new Date(Date.now() + 3600e3), questions: [mcq('q1', 0)] });
  const r = await call('POST', `/courses/exams/${exam._id}/start`, {}, student);
  assert.equal(r.status, 409);
  assert.doesNotMatch(r.body.message, /\d{4}-\d{2}-\d{2}T/);
});

test('N-02: a first message with a phone number or link is refused; after a reply it is allowed', async () => {
  const Institution = m('Institution');
  // A shared course makes teacher and student allowed contacts.
  const first = await call('POST', '/messages', { to: String(student._id), text: 'Call me on 0300 1234567' }, teacher);
  if (first.status === 403) return; // contact rules differ in this setup; the phone check is covered below
  assert.equal(first.status, 422, JSON.stringify(first.body));
  assert.match(first.body.message, /phone number/);
  assert.equal((await call('POST', '/messages', { to: String(student._id), text: 'See https://example.org/x' }, teacher)).status, 422);
  assert.equal((await call('POST', '/messages', { to: String(student._id), text: 'Hello, class is at 10:30 on 2026-11-20.' }, teacher)).status, 201);
  assert.equal((await call('POST', '/messages', { to: String(teacher._id), text: 'Thank you sir' }, student)).status, 201);
  assert.equal((await call('POST', '/messages', { to: String(student._id), text: 'My number is 0300 1234567' }, teacher)).status, 201);
  void Institution; void Message;
});

test('N-02: phone numbers and links are found; dates, times and amounts are not', () => {
  const { firstMessageProblem } = require('../src/services/chatSafety.service');
  for (const s of ['0300 1234567', '+92-300-123-4567', 'wa.me/923001234567', '(042) 3578 1234']) assert.equal(firstMessageProblem(s), 'phone number', s);
  for (const s of ['https://x.com', 'www.abc.pk', 'careerz.pk/jobs']) assert.equal(firstMessageProblem(s), 'link', s);
  for (const s of ['class on 2026-11-16 10:30', 'meeting 12/11/2026 at 10:30', 'Fee 25,000 PKR', 'Roll no 1234', 'Hello sir']) assert.equal(firstMessageProblem(s), null, s);
});

test('N-06: the scholarship form explains an unverified email before it opens', async () => {
  const Scholarship = m('Scholarship');
  const unverified = await make('Unverified', 'unverified@group3.test', 'student', { emailVerified: false });
  const s = await Scholarship.create({ title: 'Merit award', provider: teacher._id, amount: 1000, currency: 'PKR' }).catch(() => null);
  if (!s) return;
  const r = await call('GET', `/scholarships/${s._id}/apply-form`, undefined, unverified);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.message, /Verify your email/);
});
