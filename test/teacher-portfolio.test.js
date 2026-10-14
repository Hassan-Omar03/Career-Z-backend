const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Teacher categories and public profile, verified teaching hours with Bronze/Silver/Gold badges
// from real records only, the opt-in public portfolio (nothing private exposed) and the
// plagiarism check across an assignment's written submissions.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 300)}`);
async function account(name, role, extra = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@portfolio.test`, passwordHash: 'x', emailVerified: true, roles: [role], ...extra });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Sana', 'teacher', { profilePhoto: 'https://res.cloudinary.com/demo/image/upload/sana.jpg' });
  await account('Other', 'teacher');
  for (let i = 0; i < 6; i++) await account(`Pupil${i}`, 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('teacher sets categories, cover, intro video, style and modes; bad values are refused', async () => {
  let r = await api('Sana', 'PATCH', '/teachers/me', {
    categories: ['tuition_teacher', 'online_instructor'], coverPhotoUrl: 'https://res.cloudinary.com/demo/image/upload/cover.jpg',
    introVideoUrl: 'https://www.youtube.com/watch?v=abc123', teachingStyle: 'Concept first, then lots of practice.', teachingModes: ['online', 'in_person'],
    subjects: ['Physics'], experienceYears: 6, bio: 'O/A-Level physics tutor', qualifications: [{ title: 'MPhil Physics', institutionName: 'QAU', year: 2018, documentUrl: 'https://private.example/degree.pdf' }]
  });
  expect(r, 200, 'save profile');
  assert.deepEqual(r.body.data.categories, ['tuition_teacher', 'online_instructor']);
  for (const bad of [{ categories: ['wizard'] }, { coverPhotoUrl: 'http://insecure.example/x.jpg' }, { teachingModes: ['telepathy'] }]) {
    r = await api('Sana', 'PATCH', '/teachers/me', bad);
    assert.ok(r.status >= 400 && r.status < 500, `refuse ${JSON.stringify(bad)} → ${r.status}`);
  }
});

test('public portfolio exists only when switched on and never exposes private data', async () => {
  expect(await api(null, 'GET', `/teachers/${u.Sana._id}/public`), 404, 'off by default');
  expect(await api('Sana', 'PATCH', '/teachers/me', { publicPortfolio: true }), 200);
  const r = await api(null, 'GET', `/teachers/${u.Sana._id}/public`);
  expect(r, 200, 'public page');
  const d = r.body.data;
  assert.equal(d.teacher.fullName, 'Sana');
  assert.deepEqual(d.profile.categories, ['tuition_teacher', 'online_instructor']);
  assert.equal(d.profile.qualifications[0].title, 'MPhil Physics');
  const raw = JSON.stringify(r.body);
  for (const secret of ['private.example', 'portfolio.test', 'passwordHash', 'payout']) assert.ok(!raw.includes(secret), `must not expose ${secret}`);
  expect(await api(null, 'GET', `/teachers/${u.Other._id}/public`), 404, 'other teacher private');
  expect(await api(null, 'GET', '/teachers/not-an-id/public'), 404);
});

test('verified hours and badges come from real records only, with what the next badge needs', async () => {
  let r = await api('Sana', 'GET', '/teachers/me/standing');
  expect(r, 200);
  assert.deepEqual([r.body.data.verifiedHours, r.body.data.badge], [0, null]);
  assert.equal(r.body.data.next.label, 'Bronze');

  const course = await model('Course').create({ title: 'A-Level Physics', subject: 'Physics', teacher: u.Sana._id, published: true });
  const start = new Date('2026-09-01T10:00:00Z');
  const sessions = Array.from({ length: 9 }, (_, i) => ({ course: course._id, teacher: u.Sana._id, title: `Class ${i}`, status: 'ended', startedAt: new Date(start.getTime() + i * 864e5), endedAt: new Date(start.getTime() + i * 864e5 + 36e5) }));
  sessions.push({ course: course._id, teacher: u.Sana._id, title: 'Left open', status: 'ended', startedAt: new Date('2026-09-20T10:00:00Z'), endedAt: new Date('2026-09-21T10:00:00Z') });
  sessions.push({ course: course._id, teacher: u.Sana._id, title: 'Never ran', status: 'scheduled' });
  await model('LiveClassSession').insertMany(sessions, { lean: true });
  for (let i = 0; i < 6; i++) await model('Enrollment').create({ course: course._id, student: u[`Pupil${i}`]._id });
  for (let i = 0; i < 3; i++) await model('TeacherFeedback').create({ teacher: u.Sana._id, fromUser: u[`Pupil${i}`]._id, fromRole: 'student', rating: [4, 4, 5][i], comment: i === 0 ? 'Explains clearly' : '' });

  r = await api('Sana', 'GET', '/teachers/me/standing');
  const s = r.body.data;
  assert.equal(s.verifiedHours, 15, '9 one-hour classes + a 24h open session capped at 6h; scheduled ones never count');
  assert.equal(s.studentsTaught, 6);
  assert.deepEqual([s.reviews.count, s.reviews.average], [3, 4.3]);
  assert.equal(s.badge.label, 'Bronze');
  assert.equal(s.next.label, 'Silver');
  assert.ok(s.next.needs.some((n) => /35 more verified teaching hours/.test(n)), JSON.stringify(s.next.needs));

  r = await api(null, 'GET', `/teachers/${u.Sana._id}/public`);
  assert.equal(r.body.data.standing.badge.label, 'Bronze');
  assert.equal(r.body.data.courses[0].title, 'A-Level Physics');
  assert.equal(r.body.data.reviews.length, 1, 'only reviews with a comment, no reviewer names');
  assert.ok(!('fromUser' in r.body.data.reviews[0]));
});

test('plagiarism check flags copied answers within an assignment; only the owner teacher can run it', async () => {
  const course = await model('Course').findOne({ teacher: u.Sana._id });
  const assignment = await model('Assignment').create({ course: course._id, teacher: u.Sana._id, title: 'Explain Newton’s laws', maxMarks: 10 });
  const essay = 'Newton first law says an object stays at rest or keeps moving at the same speed in a straight line unless an unbalanced force acts on it and this property is called inertia which depends on mass so heavier objects resist changes in motion more than lighter objects do in everyday life';
  const own = 'Forces change motion. When I push a trolley it speeds up and when I stop pushing friction slows it down until it stops which shows that motion needs a cause and the second law links force mass and acceleration together so doubling force doubles the acceleration of the same trolley we tested';
  await model('Submission').create([
    { assignment: assignment._id, student: u.Pupil0._id, text: essay },
    { assignment: assignment._id, student: u.Pupil1._id, text: `In my words: ${essay}` },
    { assignment: assignment._id, student: u.Pupil2._id, text: own },
    { assignment: assignment._id, student: u.Pupil3._id, text: 'Too short to compare.' }
  ]);
  const r = await api('Sana', 'GET', `/courses/assignments/${assignment._id}/similarity`);
  expect(r, 200, 'similarity');
  const d = r.body.data;
  assert.deepEqual([d.checked, d.skippedShort, d.pairs.length], [3, 1, 1]);
  assert.deepEqual([d.pairs[0].a.student, d.pairs[0].b.student].sort(), ['Pupil0', 'Pupil1']);
  assert.equal(d.pairs[0].level, 'high');
  assert.match(d.scope, /internet sources are not checked/);
  expect(await api('Other', 'GET', `/courses/assignments/${assignment._id}/similarity`), 403, 'other teacher');
});

test('Find Teachers: filter by teacher type; search text is treated as plain text', async () => {
  await account('Head', 'institution_owner');
  const school = await model('Institution').create({ name: 'Directory School', slug: 'directory-school', type: 'school', country: 'PK', owner: u.Head._id, verificationStatus: 'approved' });
  let r = await api('Head', 'GET', `/institutions/${school._id}/teacher-directory?category=tuition_teacher`);
  expect(r, 200, 'directory by type');
  const sana = r.body.data.find((t) => t.fullName === 'Sana');
  assert.ok(sana, 'tuition teacher listed');
  assert.equal(sana.portfolioUrl, `/teacher/${u.Sana._id}`);
  r = await api('Head', 'GET', `/institutions/${school._id}/teacher-directory?category=madrasa_teacher`);
  assert.ok(!r.body.data.some((t) => t.fullName === 'Sana'), 'filtered out');
  for (const q of ['a.(b', '[', '*', 'phys(']) expect(await api('Head', 'GET', `/institutions/${school._id}/teacher-directory?q=${encodeURIComponent(q)}`), 200, `search ${q}`);
  expect(await api('Head', 'GET', `/institutions/${school._id}/teacher-directory?q[]=x`), 200, 'array query ignored');
});
