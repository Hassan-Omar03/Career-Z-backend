const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Assignment = require('../src/models/Assignment');
const Submission = require('../src/models/Submission');
const Enrollment = require('../src/models/Enrollment');
const Exam = require('../src/models/Exam');
const ExamSubmission = require('../src/models/ExamSubmission');
const Result = require('../src/models/Result');
require('../src/models/Institution');
const ctrl = require('../src/controllers/course.controller');

const models = [User, Course, Assignment, Submission, Enrollment, Exam, ExamSubmission, Result];
let mongo, teacher, student, outsider, course;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((model) => model.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  teacher = await User.create({ fullName: 'Teacher', email: 'academic-teacher@test.local', passwordHash: 'unused', roles: ['teacher'] });
  student = await User.create({ fullName: 'Student', email: 'academic-student@test.local', passwordHash: 'unused', roles: ['student'] });
  outsider = await User.create({ fullName: 'Outsider', email: 'academic-outsider@test.local', passwordHash: 'unused', roles: ['student'] });
  course = await Course.create({ title: 'Physics', subject: 'Physics', teacher: teacher._id, published: true, isFree: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

test('pending assignment is visible, deadline is enforced, and revision/marks are bounded', async () => {
  const created = await invoke(ctrl.createAssignment, { user: teacher, params: { id: course._id }, body: { title: 'Lab report', dueDate: new Date(Date.now() - 1000), maxMarks: 20, allowLate: false } });
  const assignment = created.body.data;
  const visible = await invoke(ctrl.listAssignments, { user: student, params: { id: course._id } });
  assert.equal(visible.body.data.length, 1);
  await assert.rejects(() => invoke(ctrl.listAssignments, { user: outsider, params: { id: course._id } }), /not enrolled/);
  await assert.rejects(() => invoke(ctrl.submitAssignment, { user: student, params: { assignmentId: assignment._id }, body: { text: 'late work' } }), /deadline/);

  await Assignment.findByIdAndUpdate(assignment._id, { allowLate: true });
  const submitted = await invoke(ctrl.submitAssignment, { user: student, params: { assignmentId: assignment._id }, body: { text: 'late work' } });
  assert.equal(submitted.body.data.late, true);
  await assert.rejects(() => invoke(ctrl.gradeSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { marksObtained: 21 } }), /between 0 and 20/);
  await invoke(ctrl.gradeSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { marksObtained: 18, feedback: 'Good' } });
  const revision = await invoke(ctrl.requestAssignmentResubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { feedback: 'Add references' } });
  assert.equal(revision.body.data.status, 'resubmit_requested');
  assert.equal(revision.body.data.marksObtained, null);
});

test('assignment submission policy is enforced and owner deletion removes submissions', async () => {
  const created = await invoke(ctrl.createAssignment, {
    user: teacher,
    params: { id: course._id },
    body: { title: 'Handwritten worksheet', submissionMode: 'file' }
  });
  const assignment = created.body.data;
  assert.equal(assignment.submissionMode, 'file');
  await assert.rejects(
    () => invoke(ctrl.submitAssignment, { user: student, params: { assignmentId: assignment._id }, body: { text: 'typed answer' } }),
    /requires a completed file/
  );
  const submitted = await invoke(ctrl.submitAssignment, {
    user: student,
    params: { assignmentId: assignment._id },
    body: { attachments: [{ name: 'worksheet.pdf', url: 'https://files.test/worksheet.pdf' }] }
  });
  assert.equal(submitted.status, 201);
  await assert.rejects(
    () => invoke(ctrl.deleteAssignment, { user: outsider, params: { assignmentId: assignment._id } }),
    /do not own/
  );
  await invoke(ctrl.deleteAssignment, { user: teacher, params: { assignmentId: assignment._id } });
  assert.equal(await Assignment.countDocuments({ _id: assignment._id }), 0);
  assert.equal(await Submission.countDocuments({ assignment: assignment._id }), 0);
});

test('exam cannot start early; MCQ submission waits for teacher grading and result is idempotent', async () => {
  const future = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Future quiz', published: true, scheduledDate: new Date(Date.now() + 60000), durationMinutes: 10, questions: [{ text: '2+2?', type: 'mcq', options: ['3', '4'], correctOption: 1, marks: 5 }] });
  await assert.rejects(() => invoke(ctrl.startExam, { user: student, params: { examId: future._id } }), /opens at/);
  future.scheduledDate = new Date(Date.now() - 1000); await future.save();
  const started = await invoke(ctrl.startExam, { user: student, params: { examId: future._id } });
  assert.equal(started.body.data.attempt.status, 'in_progress');
  await assert.rejects(() => invoke(ctrl.listExams, { user: outsider, params: { id: course._id } }), /not enrolled/);
  const submitted = await invoke(ctrl.submitExam, { user: student, params: { examId: future._id }, body: { answers: [{ questionIndex: 0, selectedOption: 1 }] } });
  assert.equal(submitted.body.data.score, 0);
  assert.equal(submitted.body.data.status, 'submitted');
  assert.equal(await Result.countDocuments({ student: student._id, exam: future._id }), 0);
  await invoke(ctrl.gradeExamSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { manualMarks: [{ questionIndex: 0, marks: 4 }], grade: 'B' } });
  assert.equal((await Result.findOne({ student: student._id, exam: future._id })).marksObtained, 4);
  await assert.rejects(() => invoke(ctrl.submitExam, { user: student, params: { examId: future._id }, body: { answers: [{ questionIndex: 0, selectedOption: 1 }] } }), /already submitted/);
});

test('short-answer grading rejects excessive marks and updates one result on regrade', async () => {
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Written test', published: true, durationMinutes: 0, questions: [{ text: 'Explain gravity', type: 'short', marks: 10 }] });
  await invoke(ctrl.startExam, { user: student, params: { examId: exam._id } });
  const submitted = await invoke(ctrl.submitExam, { user: student, params: { examId: exam._id }, body: { answers: [{ questionIndex: 0, textAnswer: 'Attraction' }] } });
  await assert.rejects(() => invoke(ctrl.gradeExamSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { manualMarks: [{ questionIndex: 0, marks: 11 }], grade: 'A' } }), /Invalid marks/);
  await invoke(ctrl.gradeExamSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { manualMarks: [{ questionIndex: 0, marks: 8 }], grade: 'B+' } });
  await invoke(ctrl.gradeExamSubmission, { user: teacher, params: { submissionId: submitted.body.data._id }, body: { manualMarks: [{ questionIndex: 0, marks: 9 }], grade: 'A' } });
  assert.equal(await Result.countDocuments({ student: student._id, exam: exam._id }), 1);
  assert.equal((await Result.findOne({ student: student._id, exam: exam._id })).marksObtained, 9);
});
