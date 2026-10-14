const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// AI Teacher Assistant: a teacher picks one of their own classes and the AI request carries that
// class's real subject, section, level and institution. Other teachers' classes are refused.
process.env.NODE_ENV = 'test';
const ai = require('../src/services/ai.service');
let calls = [];
mock.method(ai, 'generate', async (...args) => { calls.push(args); return 'Draft'; });
const ctrl = require('../src/controllers/ai.controller');
const model = (n) => require(`../src/models/${n}`);
let mongo;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, req) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

test('teacher tools carry the chosen class context; other classes and student tools are refused', async () => {
  const owner = await model('User').create({ fullName: 'Ctx Owner', email: 'ctx-owner@t.local', passwordHash: 'x', roles: ['institution_owner'] });
  const teacher = await model('User').create({ fullName: 'Ctx Teacher', email: 'ctx-teacher@t.local', passwordHash: 'x', roles: ['teacher'] });
  const other = await model('User').create({ fullName: 'Other Teacher', email: 'ctx-other@t.local', passwordHash: 'x', roles: ['teacher'] });
  const student = await model('User').create({ fullName: 'Ctx Student', email: 'ctx-student@t.local', passwordHash: 'x', roles: ['student'] });
  const inst = await model('Institution').create({ name: 'Context University', slug: 'context-university', type: 'university', country: 'PK', owner: owner._id });
  const section = await model('ClassSection').create({ institution: inst._id, name: 'BSCS Semester 1 - A', academicYear: '2026-27' });
  const course = await model('Course').create({ institution: inst._id, teacher: teacher._id, title: 'Programming Fundamentals', subject: 'Programming Fundamentals', level: 'BS Semester 1', classSection: section._id });
  await model('Enrollment').create({ course: course._id, student: student._id });

  const ask = (user, body) => invoke(ctrl.generate, { user, body });
  const ok = await ask(teacher, { feature: 'teacher_quiz', prompt: 'loops and arrays', courseId: course._id });
  assert.equal(ok.status, 200, ok.body.message);
  const sent = calls[0][2];
  for (const part of ['Subject: Programming Fundamentals', 'Class / section: BSCS Semester 1 - A', 'Academic year: 2026-27', 'Level: BS Semester 1', 'Institution: Context University', 'Enrolled students: 1']) assert.ok(sent.includes(part), `missing "${part}" in:\n${sent}`);
  assert.ok(sent.trimEnd().endsWith('loops and arrays'));

  // Without a class the request is passed through unchanged.
  await ask(teacher, { feature: 'teacher_notes', prompt: 'recursion' });
  assert.equal(calls[1][2], 'recursion');

  assert.equal((await ask(other, { feature: 'teacher_quiz', prompt: 'x', courseId: course._id })).status, 403);
  assert.equal((await ask(teacher, { feature: 'student_homework', prompt: 'x', courseId: course._id })).status, 422);
  assert.equal((await ask(teacher, { feature: 'teacher_quiz', prompt: 'x', courseId: new mongoose.Types.ObjectId() })).status, 404);
  assert.equal(calls.length, 2);
});
