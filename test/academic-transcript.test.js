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
const Enrollment = require('../src/models/Enrollment');
const Result = require('../src/models/Result');
const ClassSection = require('../src/models/ClassSection');
const StudentProfile = require('../src/models/StudentProfile');
const { buildTranscript } = require('../src/services/certificate.service');
const ctrl = require('../src/controllers/course.controller');

const models = [User, Course, Enrollment, Result, ClassSection, StudentProfile];
let mongo, teacher, student, institution;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((model) => model.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  teacher = await User.create({ fullName: 'Teacher', email: 'transcript-teacher@test.local', passwordHash: 'unused', roles: ['teacher'] });
  student = await User.create({ fullName: 'Student', email: 'transcript-student@test.local', passwordHash: 'unused', roles: ['student'] });
  institution = new mongoose.Types.ObjectId();
  await StudentProfile.create({ user: student._id, primaryInstitution: institution });
});

const mkCourse = (title, extra = {}) => Course.create({ title, subject: title, teacher: teacher._id, institution, creditHours: 3, ...extra });
const mkResult = (course, marksObtained, totalMarks, extra = {}) => Result.create({ student: student._id, course: course._id, institution, marksObtained, totalMarks, recordedBy: teacher._id, ...extra });

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

test('CGPA is credit-weighted and grade boundaries hold', async () => {
  const math = await mkCourse('Math', { creditHours: 4, academicTerm: 'Semester 1' });
  const english = await mkCourse('English', { creditHours: 2, academicTerm: 'Semester 1' });
  await mkResult(math, 85, 100); await mkResult(english, 49.99, 100);
  const transcript = await buildTranscript(student._id, institution);
  const bySubject = Object.fromEntries(transcript.rows.map((row) => [row.subject, row]));
  assert.equal(bySubject.Math.grade, 'A'); assert.equal(bySubject.Math.gradePoints, 4);
  assert.equal(bySubject.English.grade, 'F'); assert.equal(bySubject.English.gradePoints, 0);
  assert.equal(transcript.totalCredits, 6);
  assert.equal(transcript.cgpa, 2.67); // (4*4 + 0*2) / 6
});

test('every assessment of one course pools into a single transcript row', async () => {
  const physics = await mkCourse('Physics', { academicTerm: 'Semester 1' });
  await mkResult(physics, 20, 30, { term: 'Mid Term' }); // offline entry: term is the assessment name
  await mkResult(physics, 20, 70, { term: 'Final' });
  const transcript = await buildTranscript(student._id, institution);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].term, 'Semester 1');
  assert.equal(transcript.rows[0].percentage, 40);
  assert.equal(transcript.rows[0].grade, 'F');
  assert.equal(transcript.totalCredits, 3);
  assert.equal(transcript.semesterSummaries.length, 1);
});

test('legacy exam results that stored the exam type as term still pool and get no fake semester', async () => {
  const chem = await mkCourse('Chemistry');
  await mkResult(chem, 8, 10, { exam: new mongoose.Types.ObjectId(), term: 'quiz' });
  await mkResult(chem, 72, 90, { exam: new mongoose.Types.ObjectId(), term: 'final' });
  const transcript = await buildTranscript(student._id, institution);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].term, 'Term not specified');
  assert.equal(transcript.rows[0].percentage, 80);
});

test('an exam term labels the semester when the course has none', async () => {
  const bio = await mkCourse('Biology');
  await mkResult(bio, 30, 50, { term: 'Mid Term' });
  await mkResult(bio, 40, 50, { exam: new mongoose.Types.ObjectId(), term: 'Semester 2' });
  const transcript = await buildTranscript(student._id, institution);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].term, 'Semester 2');
});

test('the same term name in two academic sessions yields two semester GPAs', async () => {
  const math = await mkCourse('Math', { academicTerm: 'Fall' });
  const bio = await mkCourse('Biology', { academicTerm: 'Fall' });
  await mkResult(math, 90, 100, { academicSession: '2025' });
  await mkResult(bio, 40, 100, { academicSession: '2026' });
  const transcript = await buildTranscript(student._id, institution);
  const summaries = Object.fromEntries(transcript.semesterSummaries.map((item) => [`${item.term} ${item.academicSession}`, item.gpa]));
  assert.deepEqual(summaries, { 'Fall 2025': 4, 'Fall 2026': 0 });
  assert.equal(transcript.cgpa, 2);
});

test('results without a session inherit the class section academic year', async () => {
  const section = await ClassSection.create({ institution, name: 'Grade 10-A', academicYear: '2026-2027' });
  const urdu = await mkCourse('Urdu', { academicTerm: 'Semester 1', classSection: section._id });
  await mkResult(urdu, 30, 50, { term: 'Mid Term' }); // offline entry, no session
  await mkResult(urdu, 40, 50, { exam: new mongoose.Types.ObjectId(), term: 'Semester 1', academicSession: '2026-2027' });
  const transcript = await buildTranscript(student._id, institution);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].academicSession, '2026-2027');
  assert.equal(transcript.rows[0].percentage, 70);
});

test('zero-total results are ignored instead of producing NaN', async () => {
  const art = await mkCourse('Art', { academicTerm: 'Semester 1' });
  await mkResult(art, 0, 0);
  await assert.rejects(buildTranscript(student._id, institution), /No graded academic results/);
  await mkResult(art, 45, 50);
  const transcript = await buildTranscript(student._id, institution);
  assert.equal(transcript.rows[0].percentage, 90);
  assert.ok(Number.isFinite(transcript.cgpa));
});

test('a teacher cannot record a result with zero total or out-of-range marks', async () => {
  const course = await mkCourse('History');
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
  const record = (body) => invoke(ctrl.recordResult, { user: teacher, params: { id: String(course._id) }, body: { student: String(student._id), ...body } });
  await assert.rejects(record({ marksObtained: 0, totalMarks: 0 }), /greater than zero/);
  await assert.rejects(record({ marksObtained: 60, totalMarks: 50 }), /between 0 and totalMarks/);
  await assert.rejects(record({ marksObtained: -1, totalMarks: 50 }), /between 0 and totalMarks/);
  const ok = await record({ marksObtained: 50, totalMarks: 50, term: 'Final' });
  assert.equal(ok.status, 201);
});
