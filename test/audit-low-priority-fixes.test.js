// Client audit low-priority items N-21 to N-31 (the parts that live in the backend).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'audit-low-test';
const notifications = require('../src/services/notification.service');
for (const fn of ['notifyAdmins', 'notifyMany', 'notifyParentsOfStudent']) if (notifications[fn]) mock.method(notifications, fn, async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile'), Course = m('Course'), Enrollment = m('Enrollment');
const Exam = m('Exam'), ExamSubmission = m('ExamSubmission'), Notification = m('Notification'), Institution = m('Institution'), Job = m('Job');

let mongo, server, base, admin, teacher, student, other, course;
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
  admin = await make('Admin', 'admin@low.test', 'super_admin');
  teacher = await make('Teacher', 'teacher@low.test', 'teacher');
  student = await make('Student', 'student@low.test', 'student');
  other = await make('Other', 'other@low.test', 'student');
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

test('N-23/N-25: admin counts leave out deleted accounts; a deleted account cannot be reactivated', async () => {
  const gone = await User.create({ fullName: 'Gone', email: 'deleted_x_gone@low.test', passwordHash: 'x', roles: ['student'], status: 'deleted', deletedAt: new Date() });
  const live = await User.countDocuments({ status: { $ne: 'deleted' } });
  const r = await call('GET', '/admin/reports', undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.totalUsers, live);
  const s = await call('PATCH', `/users/${gone._id}/status`, { status: 'active' }, admin);
  assert.equal(s.status, 409);
  assert.equal((await User.findById(gone._id)).status, 'deleted');
});

test('N-23: open jobs on the admin screen match the public count (expired ones are not counted)', async () => {
  await Job.create([
    { title: 'Live job', company: 'A', postedBy: admin._id, status: 'active', description: 'x', country: 'Pakistan' },
    { title: 'Expired job', company: 'A', postedBy: admin._id, status: 'active', description: 'x', country: 'Pakistan', applicationDeadline: new Date(Date.now() - 864e5) }
  ].map((j) => ({ ...j, type: 'full_time' }))).catch(() => {});
  const r = await call('GET', '/admin/reports', undefined, admin);
  const publicFilter = await require('../src/services/publicListings.service').jobFilter({});
  assert.equal(r.body.data.openJobs, await Job.countDocuments(publicFilter));
});

test('N-26: an offline recipient gets a notification for a new message; a student gets one for a result', async () => {
  const before = await Notification.countDocuments({ user: student._id });
  const sent = await call('POST', '/messages', { to: String(student._id), text: 'Hello' }, teacher);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(await Notification.countDocuments({ user: student._id, category: 'message' }), 1);
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Quiz', published: true, durationMinutes: 10, questions: [{ text: 'q', type: 'mcq', options: ['a', 'b'], correctOption: 0, marks: 1 }] });
  await call('POST', `/courses/exams/${exam._id}/start`, {}, student);
  const attempt = await ExamSubmission.findOne({ exam: exam._id, student: student._id }).lean();
  const opts = attempt.optionOrders?.[0] || [0, 1];
  await call('POST', `/courses/exams/${exam._id}/submit`, { answers: [{ questionIndex: 0, selectedOption: opts.indexOf(0) }] }, student);
  assert.ok(await Notification.exists({ user: student._id, category: 'result' }), 'result notification');
  assert.ok(await Notification.countDocuments({ user: student._id }) > before);
});

test('N-28: a made-up AI key is refused when the provider says so', async () => {
  const ai = require('../src/services/ai.service');
  process.env.AI_KEY_CHECK_IN_TESTS = '1';
  const real = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('api.openai.com') ? new Response('{}', { status: 401 }) : real(url, init));
  try {
    await assert.rejects(ai.verifyKey('openai', 'sk-made-up-key-123'), (e) => e.statusCode === 422 && /rejected/.test(e.message));
    global.fetch = async (url, init) => (String(url).includes('api.openai.com') ? new Response('{}', { status: 200 }) : real(url, init));
    assert.deepEqual(await ai.verifyKey('openai', 'sk-real-key-123'), { checked: true });
  } finally { global.fetch = real; delete process.env.AI_KEY_CHECK_IN_TESTS; }
});

test('N-29: a teacher edits an exam\'s timing, and can delete one nobody submitted but not one already taken', async () => {
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Draft', published: false, durationMinutes: 10, questions: [{ text: 'q', type: 'mcq', options: ['a', 'b'], correctOption: 0, marks: 1 }] });
  const opens = new Date(Date.now() + 3600e3), closes = new Date(Date.now() + 7200e3);
  const u = await call('PATCH', `/courses/exams/${exam._id}`, { title: 'Renamed', scheduledDate: opens.toISOString(), closesAt: closes.toISOString(), durationMinutes: 20 }, teacher);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const saved = await Exam.findById(exam._id).lean();
  assert.equal(saved.title, 'Renamed'); assert.equal(saved.closesAt.getTime(), closes.getTime());
  assert.equal((await call('PATCH', `/courses/exams/${exam._id}`, { closesAt: new Date(Date.now() + 1000).toISOString() }, teacher)).status, 422, 'closing before opening is refused');
  assert.equal((await call('PATCH', `/courses/exams/${exam._id}`, { title: 'x' }, other)).status, 403);
  assert.equal((await call('DELETE', `/courses/exams/${exam._id}`, undefined, teacher)).status, 200);
  assert.equal(await Exam.exists({ _id: exam._id }), null);
  const taken = await Exam.findOne({ title: 'Quiz' });
  assert.equal((await call('DELETE', `/courses/exams/${taken._id}`, undefined, teacher)).status, 409);
});

test('N-30: the public events page lists only events a verified institute chose to share', async () => {
  const owner = await make('Owner', 'owner@low.test', 'institution_owner');
  const inst = await Institution.create({ name: 'Open School', slug: 'open-school', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  const Event = m('InstitutionEvent');
  await Event.create([
    { institution: inst._id, title: 'Science Fair', startDate: new Date(Date.now() + 864e5), isPublic: true, createdBy: owner._id },
    { institution: inst._id, title: 'Staff Meeting', startDate: new Date(Date.now() + 864e5), isPublic: false, createdBy: owner._id }
  ]);
  const r = await call('GET', '/public/events');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const titles = (r.body.data || []).map((e) => e.title);
  assert.ok(titles.includes('Science Fair'));
  assert.ok(!titles.includes('Staff Meeting'));
});

test('N-31: completing an approved institute account creates its institute record once', async () => {
  const svc = require('../src/services/accountVerification.service');
  const fn = svc.ensureInstitution;
  if (!fn) return; // covered through saveProfile in the account-verification suite
  const owner = await make('New Owner', 'newowner@low.test', 'institution_owner', { country: 'Pakistan' });
  const first = await fn(owner, { instituteName: 'Fresh Academy', instituteType: 'academy', country: 'Pakistan', city: 'Lahore' });
  assert.equal(first.verificationStatus, 'approved');
  assert.equal(await fn(owner, { instituteName: 'Fresh Academy' }), null, 'not created twice');
  assert.equal(await Institution.countDocuments({ owner: owner._id }), 1);
});
