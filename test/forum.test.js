const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
const notified = [];
mock.method(notifications, 'notify', async (userId, payload) => { notified.push({ userId: String(userId), title: payload.title }); });

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const ForumThread = require('../src/models/ForumThread');
const ForumReply = require('../src/models/ForumReply');
const ctrl = require('../src/controllers/forum.controller');

const models = [User, Institution, Course, Enrollment, ForumThread, ForumReply];
let mongo, owner, moderator, teacher, alice, bob, outsider, course;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  notified.length = 0;
  [owner, moderator, teacher, alice, bob, outsider] = await User.create(['owner', 'mod', 'teacher', 'alice', 'bob', 'out'].map((n) => ({ fullName: n, email: `${n}@forum.test`, passwordHash: 'x' })));
  const institution = await Institution.create({ name: 'Uni', slug: 'uni-forum', type: 'university', country: 'PK', owner: owner._id, staff: [{ user: moderator._id, role: 'staff', permissions: ['forum:moderate'] }] });
  course = await Course.create({ title: 'Chemistry', teacher: teacher._id, institution: institution._id, published: true });
  await Enrollment.create([{ student: alice._id, course: course._id, status: 'active' }, { student: bob._id, course: course._id, status: 'active' }]);
});

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, query }, res, reject)).catch(reject);
  });
}

test('enrolled students ask, classmates and the teacher reply, people are notified, outsiders are kept out', async () => {
  const thread = (await invoke(ctrl.createThread, { user: alice, params: { courseId: course.id }, body: { title: 'What is a mole?', body: 'Confused about Avogadro' } })).body.data;
  assert.ok(notified.some((n) => n.userId === teacher.id && /New question/.test(n.title)));
  await invoke(ctrl.createReply, { user: bob, params: { id: thread._id }, body: { body: 'It is 6.022e23 particles.' } });
  const teacherReply = (await invoke(ctrl.createReply, { user: teacher, params: { id: thread._id }, body: { body: 'Correct, Bob.' } })).body.data;
  assert.equal(teacherReply.byTeacher, true);
  assert.ok(notified.some((n) => n.userId === alice.id && /New reply/.test(n.title)));
  const view = (await invoke(ctrl.getThread, { user: alice, params: { id: thread._id } })).body.data;
  assert.equal(view.replies.length, 2);
  assert.equal(view.thread.replyCount, 2);
  await assert.rejects(invoke(ctrl.listThreads, { user: outsider, params: { courseId: course.id } }), { statusCode: 403 });
  await assert.rejects(invoke(ctrl.createReply, { user: outsider, params: { id: thread._id }, body: { body: 'spam' } }), { statusCode: 403 });
});

test('moderation: teacher/moderator pin, lock and hide; students cannot; hidden content disappears for others', async () => {
  const thread = (await invoke(ctrl.createThread, { user: alice, params: { courseId: course.id }, body: { title: 'Off topic post' } })).body.data;
  await assert.rejects(invoke(ctrl.updateThread, { user: bob, params: { id: thread._id }, body: { hidden: true } }), { statusCode: 403 });
  await invoke(ctrl.updateThread, { user: moderator, params: { id: thread._id }, body: { locked: true, pinned: true } });
  await assert.rejects(invoke(ctrl.createReply, { user: bob, params: { id: thread._id }, body: { body: 'late' } }), { statusCode: 409 });
  await invoke(ctrl.updateThread, { user: teacher, params: { id: thread._id }, body: { hidden: true, hiddenReason: 'Off topic' } });
  assert.equal((await invoke(ctrl.listThreads, { user: bob, params: { courseId: course.id } })).body.data.length, 0);
  assert.equal((await invoke(ctrl.listThreads, { user: alice, params: { courseId: course.id } })).body.data.length, 1); // author still sees own
  assert.equal((await invoke(ctrl.listThreads, { user: owner, params: { courseId: course.id } })).body.data.length, 1);
  await assert.rejects(invoke(ctrl.updateThread, { user: teacher, params: { id: thread._id }, body: { title: 'teacher rewrites' } }), { statusCode: 403 });
});

test('replies: author edits, moderator hides, likes toggle, asker or teacher marks the accepted answer', async () => {
  const thread = (await invoke(ctrl.createThread, { user: alice, params: { courseId: course.id }, body: { title: 'Balancing equations' } })).body.data;
  const reply = (await invoke(ctrl.createReply, { user: bob, params: { id: thread._id }, body: { body: 'Count atoms on each side' } })).body.data;
  await assert.rejects(invoke(ctrl.updateReply, { user: alice, params: { id: reply._id }, body: { body: 'changed' } }), { statusCode: 403 });
  await invoke(ctrl.updateReply, { user: bob, params: { id: reply._id }, body: { body: 'Count atoms of each element on each side' } });
  assert.deepEqual((await invoke(ctrl.toggleLike, { user: alice, params: { id: reply._id } })).body.data, { liked: true, likes: 1 });
  assert.deepEqual((await invoke(ctrl.toggleLike, { user: alice, params: { id: reply._id } })).body.data, { liked: false, likes: 0 });
  await assert.rejects(invoke(ctrl.acceptReply, { user: bob, params: { id: thread._id }, body: { replyId: reply._id } }), { statusCode: 403 });
  await invoke(ctrl.acceptReply, { user: alice, params: { id: thread._id }, body: { replyId: reply._id } });
  assert.equal(String((await ForumThread.findById(thread._id)).acceptedReply), reply._id.toString());
  await invoke(ctrl.updateReply, { user: teacher, params: { id: reply._id }, body: { hidden: true } });
  assert.equal((await invoke(ctrl.getThread, { user: alice, params: { id: thread._id } })).body.data.replies.length, 0);
});
