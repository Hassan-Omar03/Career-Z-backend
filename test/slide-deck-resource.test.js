const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');
const Enrollment = require('../src/models/Enrollment');
const Institution = require('../src/models/Institution');
const ctrl = require('../src/controllers/course.controller');

let mongo, teacher, student, course;
const models = [User, Course, Lesson, Enrollment, Institution];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  teacher = await User.create({ fullName: 'Deck Teacher', email: 'deck-teacher@test.local', passwordHash: 'unused', roles: ['teacher'] });
  student = await User.create({ fullName: 'Deck Student', email: 'deck-student@test.local', passwordHash: 'unused', roles: ['student'] });
  course = await Course.create({ title: 'Deck Course', teacher: teacher._id, subject: 'Science', published: true, isFree: true });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

const deck = { slides: [
  { title: 'Water Cycle', bullets: ['Evaporation', 'Condensation'], background: '#f0fff4', accent: '#16a34a', text: '#14532d', imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' },
  { title: 'Review', bullets: ['Name the stages'], background: '#ffffff', accent: '#d97706', text: '#111827', imageUrl: '' }
] };

test('teacher shares a persistent deck; student sees it until teacher unpublishes or deletes it', async () => {
  const shared = await invoke(ctrl.shareAiResource, { user: teacher, params: { id: course._id }, body: { title: 'Water Cycle Slides', deck } });
  assert.equal(shared.status, 201);
  assert.equal(shared.body.data.lesson.kind, 'slide_deck');
  assert.equal(shared.body.data.lesson.deck.slides.length, 2);
  assert.equal(shared.body.data.notifiedCount, 1);

  let studentView = await invoke(ctrl.getCourse, { user: student, params: { id: course._id } });
  assert.equal(studentView.body.data.lessons.length, 1);
  assert.equal(studentView.body.data.lessons[0].deck.slides[0].title, 'Water Cycle');

  const lessonId = shared.body.data.lesson._id;
  await invoke(ctrl.updateLesson, { user: teacher, params: { lessonId }, body: { published: false } });
  studentView = await invoke(ctrl.getCourse, { user: student, params: { id: course._id } });
  assert.equal(studentView.body.data.lessons.length, 0);

  await invoke(ctrl.updateLesson, { user: teacher, params: { lessonId }, body: { published: true, title: 'Updated Water Cycle Slides', deck } });
  studentView = await invoke(ctrl.getCourse, { user: student, params: { id: course._id } });
  assert.equal(studentView.body.data.lessons[0].title, 'Updated Water Cycle Slides');

  await invoke(ctrl.deleteLesson, { user: teacher, params: { lessonId } });
  assert.equal(await Lesson.countDocuments({ course: course._id }), 0);
});

test('deck sharing rejects embedded base64 images so MongoDB cannot be bloated', async () => {
  await assert.rejects(
    () => invoke(ctrl.shareAiResource, { user: teacher, params: { id: course._id }, body: { title: 'Unsafe deck', deck: { slides: [{ title: 'Bad', bullets: [], imageUrl: 'data:image/png;base64,AAAA' }] } } }),
    /permanent HTTPS storage/
  );
  assert.equal(await Lesson.countDocuments({ course: course._id }), 0);
});
