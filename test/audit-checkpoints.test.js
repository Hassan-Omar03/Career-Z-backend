// Client audit checking points: contact form (1), job image name and alt text (12) and whiteboard
// eraser/undo (16).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'audit-checkpoints-test';
const notifications = require('../src/services/notification.service');
const adminNotes = mock.method(notifications, 'notifyAdmins', async () => []);
for (const fn of ['notifyMany', 'notifyParentsOfStudent']) if (notifications[fn]) mock.method(notifications, fn, async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile'), Course = m('Course'), Enrollment = m('Enrollment');

let mongo, server, base, teacher, student, other, session;
const token = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const call = async (method, p, body, auth) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token(auth) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const make = async (fullName, email, role) => {
  const u = await User.create({ fullName, email, passwordHash: await User.hashPassword('Good@Pass123'), emailVerified: true, roles: [role], status: 'active' });
  await RoleRequest.create({ user: u._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 864e5) });
  await UserProfile.updateOne({ user: u._id, role }, { $set: { completed: true, percent: 100 } }, { upsert: true });
  return u;
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  teacher = await make('Teacher', 'teacher@cp.test', 'teacher');
  student = await make('Student', 'student@cp.test', 'student');
  other = await make('Other', 'other@cp.test', 'student');
  const course = await Course.create({ title: 'Physics', teacher: teacher._id, published: true, price: 0, currency: 'PKR', isFree: true });
  await Enrollment.create([{ student: student._id, course: course._id, status: 'active' }, { student: other._id, course: course._id, status: 'active' }]);
  session = await m('LiveClassSession').create({ course: course._id, teacher: teacher._id, createdBy: teacher._id, title: 'Live', scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3600e3), roomName: 'cp-' + Date.now(), status: 'live' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('Point 1: the contact form saves the enquiry, tells the admins and checks the fields', async () => {
  const bad = await call('POST', '/public/contact', { name: 'A', email: 'nope', enquiryType: 'x', message: 'hi' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors?.fields?.email && bad.body.errors?.fields?.message);
  const good = await call('POST', '/public/contact', { name: 'Ayesha Khan', email: 'ayesha@example.org', enquiryType: 'partnership', message: 'We would like to partner with CareerZ.', organization: 'Bright School' });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const saved = await m('ContactMessage').findOne({ email: 'ayesha@example.org' }).lean();
  assert.equal(saved.enquiryType, 'partnership');
  assert.equal(saved.organization, 'Bright School');
  assert.ok(adminNotes.mock.calls.some((c) => /Ayesha Khan/.test(c.arguments[0].title)));
  const bot = await call('POST', '/public/contact', { name: 'Bot', email: 'bot@example.org', enquiryType: 'other', message: 'buy cheap things now', website: 'spam.example' });
  assert.equal(bot.status, 200);
  assert.equal(await m('ContactMessage').exists({ email: 'bot@example.org' }), null, 'honeypot submissions are not stored');
});

test('Section 7: the News and Press pages list only their own published posts, whatever the case of the category', async () => {
  const BlogPost = m('BlogPost');
  await BlogPost.create([
    { slug: 'admissions-open', title: 'Admissions open', category: 'news', status: 'published', publishedAt: new Date(), author: teacher._id },
    { slug: 'press-launch', title: 'CareerZ launches', category: 'Press', status: 'published', publishedAt: new Date(), author: teacher._id },
    { slug: 'news-draft', title: 'Draft news', category: 'News', status: 'draft', author: teacher._id },
    { slug: 'study-tips', title: 'Study tips', category: 'Study tips', status: 'published', publishedAt: new Date(), author: teacher._id }
  ]);
  const news = await call('GET', '/blog?category=News');
  assert.deepEqual(news.body.data.map((p) => p.slug), ['admissions-open']);
  const press = await call('GET', '/blog?category=Press');
  assert.deepEqual(press.body.data.map((p) => p.slug), ['press-launch']);
  assert.equal((await call('GET', '/blog?category=' + encodeURIComponent('.*'))).body.data.length, 0, 'the category is matched literally');
});

test('Point 12: a job keeps its image description', async () => {
  const job = await m('Job').create({ title: 'Science Teacher', company: 'School', postedBy: teacher._id, status: 'active', description: 'x', country: 'Pakistan', image: 'https://res.cloudinary.com/demo/image/upload/v1/careerz-job-images/science-teacher-lahore-a1b2c3.jpg', imageAlt: 'Newspaper advert for a science teacher' });
  assert.equal((await m('Job').findById(job._id).lean()).imageAlt, 'Newspaper advert for a science teacher');
});

test('Point 16: whiteboard items can be erased (own only for students) and undone', async () => {
  const draw = (who, x) => call('POST', `/live-classes/${session._id}/tools`, { action: 'board', operation: { type: 'stroke', color: '#123c2f', x, y: 10, x2: x, y2: 10, points: [[x, 10], [x + 5, 15], [x + 10, 20]], w: 4 } }, who);
  assert.equal((await draw(student, 10)).status, 200);
  assert.equal((await draw(other, 50)).status, 200);
  assert.equal((await draw(student, 90)).status, 200);
  let board = (await m('LiveClassSession').findById(session._id).lean()).board;
  assert.equal(board.length, 3);
  assert.ok(board.every((b) => b.id) && board[0].w === 4);
  const othersItem = board.find((b) => b.actor === String(other._id));
  assert.equal((await call('POST', `/live-classes/${session._id}/tools`, { action: 'erase', id: othersItem.id }, student)).status, 403, 'a student cannot erase someone else');
  assert.equal((await call('POST', `/live-classes/${session._id}/tools`, { action: 'undo' }, student)).status, 200);
  board = (await m('LiveClassSession').findById(session._id).lean()).board;
  assert.equal(board.length, 2);
  assert.ok(!board.some((b) => b.x === 90), 'undo removed the student\'s last drawing');
  assert.equal((await call('POST', `/live-classes/${session._id}/tools`, { action: 'erase', id: othersItem.id }, teacher)).status, 200, 'the teacher can erase anything');
  assert.equal((await m('LiveClassSession').findById(session._id).lean()).board.length, 1);
});
