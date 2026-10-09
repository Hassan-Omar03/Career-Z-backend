const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');
require('../src/models/ContentVersion');
const ctrl = require('../src/controllers/lessonMetadata.controller');

const models = [User, Institution, Course, Lesson];
let mongo, owner, staff, teacher, student, course;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  [owner, staff, teacher, student] = await User.create(['owner', 'staff', 'teacher', 'student'].map((n) => ({ fullName: n, email: `${n}@meta.test`, passwordHash: 'x' })));
  const institution = await Institution.create({ name: 'Uni', slug: 'uni-meta', type: 'university', country: 'PK', owner: owner._id, staff: [{ user: staff._id, role: 'staff' }] });
  course = await Course.create({ title: 'Bio', teacher: teacher._id, institution: institution._id });
});
function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body }, res, reject)).catch(reject);
  });
}

test('new lessons are credited to the course teacher; approval decisions stamp the review date', async () => {
  const lesson = await Lesson.create({ course: course._id, title: 'Cells' });
  assert.equal(String(lesson.metadata.author), teacher.id);
  assert.equal(lesson.metadata.lastReviewedAt, null);
  lesson.approvalStatus = 'approved';
  lesson.approvalHistory.push({ actor: owner._id, action: 'approve' });
  await lesson.save();
  const reviewed = await Lesson.findById(lesson._id);
  assert.ok(reviewed.metadata.lastReviewedAt instanceof Date);
  assert.equal(String(reviewed.metadata.lastReviewedBy), owner.id);
});

test('teacher edits author/department/AI flag; staff can mark reviewed; students can do neither', async () => {
  const lesson = await Lesson.create({ course: course._id, title: 'DNA' });
  await invoke(ctrl.updateMetadata, { user: teacher, params: { lessonId: lesson.id }, body: { authorName: 'Dr. Ahmed (guest)', department: 'Life Sciences', aiAssisted: true, aiNote: 'Summary drafted with AI, checked by teacher' } });
  await assert.rejects(invoke(ctrl.updateMetadata, { user: student, params: { lessonId: lesson.id }, body: { aiAssisted: false } }), { statusCode: 403 });
  await assert.rejects(invoke(ctrl.markReviewed, { user: student, params: { lessonId: lesson.id } }), { statusCode: 403 });
  const stamped = (await invoke(ctrl.markReviewed, { user: staff, params: { lessonId: lesson.id } })).body.data;
  assert.equal(String(stamped.lastReviewedBy), staff.id);
  const meta = (await invoke(ctrl.getMetadata, { user: student, params: { lessonId: lesson.id } })).body.data;
  assert.equal(meta.department, 'Life Sciences');
  assert.equal(meta.aiAssisted, true);
  assert.equal(meta.author.fullName, 'teacher');
  assert.equal((await Lesson.findById(lesson._id)).revision, 2); // metadata edit = 1 revision; review stamp adds none
});
