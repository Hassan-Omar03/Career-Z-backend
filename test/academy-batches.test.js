const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Academy flow (master 15A.6 Course → Batch → Students; Student 3–4 multiple providers):
// batches with teacher, schedule, seats, fee and admission; joining, approval, waiting list,
// course enrolment, monthly/one-time fees, leaving, moving batch, teacher and parent views, report.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Ali`, email: `${name.toLowerCase()}@academy.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const monthsAgo = (n) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'academy_owner');
  await account('Tutor', 'teacher');
  await account('Ali', 'student');
  await account('Sara', 'student');
  await account('Zain', 'student');
  await account('Mom', 'parent');
  await account('School', 'institution_owner');
  S.academy = await model('Institution').create({ owner: u.Owner._id, name: 'Bright Academy', slug: 'bright-academy', type: 'academy', country: 'PK', city: 'Lahore', status: 'active', verificationStatus: 'approved', staff: [{ user: u.Tutor._id, role: 'teacher', permissions: [] }] });
  S.school = await model('Institution').create({ owner: u.School._id, name: 'City School', slug: 'city-school', type: 'school', country: 'PK', status: 'active', verificationStatus: 'approved' });
  await model('StudentInstitutionMembership').create({ student: u.Ali._id, institution: S.school._id, status: 'active', isPrimary: true });
  await model('ParentChildLink').create({ parent: u.Mom._id, student: u.Ali._id, status: 'approved', relationship: 'mother', requestedBy: u.Mom._id });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('the academy makes a course and batches with teacher, schedule, seats, fee and admission rule', async () => {
  const body = { courseTitle: 'O-level Maths', name: 'Evening A', teacher: String(u.Tutor._id), schedule: [{ day: 'mon', start: '17:00', end: '18:30' }, { day: 'wed', start: '17:00', end: '18:30' }], startDate: monthsAgo(2), seats: 2, fee: { amount: 3000, period: 'monthly' }, admission: 'auto', mode: 'on_campus', room: 'Room 3' };
  expect(await api('Ali', 'POST', `/academy/institutions/${S.academy._id}/batches`, body), 403, 'only the academy');
  expect(await api('Owner', 'POST', `/academy/institutions/${S.academy._id}/batches`, { ...body, schedule: [{ day: 'mon', start: '18:00', end: '17:00' }] }), 422, 'end before start');
  expect(await api('Owner', 'POST', `/academy/institutions/${S.academy._id}/batches`, { ...body, teacher: String(u.Zain._id) }), 422, 'teacher must be staff');
  const a = await api('Owner', 'POST', `/academy/institutions/${S.academy._id}/batches`, body);
  expect(a, 201);
  S.evening = a.body.data._id;
  S.course = a.body.data.course;
  const b = await api('Owner', 'POST', `/academy/institutions/${S.academy._id}/batches`, { ...body, courseId: S.course, courseTitle: undefined, name: 'Weekend B', seats: 5, schedule: [{ day: 'sat', start: '10:00', end: '12:00' }], admission: 'approval', fee: { amount: 15000, period: 'one_time' } });
  expect(b, 201);
  S.weekend = b.body.data._id;
  const pub = await api(null, 'GET', `/academy/institutions/${S.academy._id}/batches`);
  assert.equal(pub.body.data.length, 2);
  assert.equal(pub.body.data[0].seatsLeft, 2);
});

test('auto seats until full, then a waiting list; a seat enrols in the course, joins the academy (not primary) and bills every month', async () => {
  const a = await api('Ali', 'POST', `/academy/batches/${S.evening}/join`, {});
  expect(a, 201);
  assert.equal(a.body.data.status, 'active');
  expect(await api('Ali', 'POST', `/academy/batches/${S.evening}/join`), 409, 'already in');
  assert.equal((await api('Sara', 'POST', `/academy/batches/${S.evening}/join`)).body.data.status, 'active');
  assert.equal((await api('Zain', 'POST', `/academy/batches/${S.evening}/join`)).body.data.status, 'waitlisted', 'two seats only');
  expect(await api('Mom', 'POST', `/academy/batches/${S.evening}/join`), 403, 'students only');
  assert.ok(await model('Enrollment').exists({ student: u.Ali._id, course: S.course, status: 'active' }), 'course enrolment');
  const m = await model('StudentInstitutionMembership').find({ student: u.Ali._id }).lean();
  assert.equal(m.find((x) => String(x.institution) === String(S.academy._id)).isPrimary, false);
  assert.equal(m.find((x) => String(x.institution) === String(S.school._id)).isPrimary, true, 'primary school untouched');
  const fees = await model('Fee').find({ student: u.Ali._id, batch: S.evening }).sort({ billingPeriod: 1 }).lean();
  assert.equal(fees.length, 1, 'joined this month: billed from now');
  assert.equal(fees[0].amount, 3000);
  const mine = await api('Ali', 'GET', '/academy/mine');
  assert.equal(mine.body.data[0].batch.name, 'Evening A');
  assert.equal(mine.body.data[0].batch.teacher.fullName, 'Tutor Ali');
  assert.equal(mine.body.data[0].fees.length, 1);
});

test('next month the fee is billed again; leaving frees the seat for the waiting list and cancels future fees', async () => {
  const e = await model('BatchEnrollment').findOne({ batch: S.evening, student: u.Ali._id });
  const prev = monthsAgo(1).slice(0, 7);
  await model('BatchEnrollment').updateOne({ _id: e._id }, { $set: { billedThrough: prev } });
  await model('Fee').updateMany({ student: u.Ali._id, batch: S.evening }, { $set: { billingPeriod: prev } });
  await api('Ali', 'GET', '/academy/mine');
  assert.equal(await model('Fee').countDocuments({ student: u.Ali._id, batch: S.evening }), 2, 'a new month, a new fee');
  const sara = await model('BatchEnrollment').findOne({ batch: S.evening, student: u.Sara._id });
  expect(await api('Sara', 'POST', `/academy/enrollments/${sara._id}/leave`, { reason: 'Moving city' }), 200);
  const zain = await model('BatchEnrollment').findOne({ batch: S.evening, student: u.Zain._id }).lean();
  assert.equal(zain.status, 'active', 'the next in line got the seat');
  assert.equal(await model('Enrollment').countDocuments({ student: u.Sara._id, course: S.course, status: 'active' }), 0, 'course enrolment dropped');
});

test('approval batch: the academy accepts or declines; a student moves batch; teacher, parent and report views', async () => {
  const r = await api('Sara', 'POST', `/academy/batches/${S.weekend}/join`, { note: 'Weekends suit me' });
  assert.equal(r.body.data.status, 'pending');
  expect(await api('Tutor', 'PATCH', `/academy/enrollments/${r.body.data._id}/decide`, { approve: true }), 403, 'a teacher without the permission cannot accept');
  expect(await api('Owner', 'PATCH', `/academy/enrollments/${r.body.data._id}/decide`, { approve: true }), 200);
  assert.equal((await model('BatchEnrollment').findById(r.body.data._id).lean()).status, 'active');
  assert.equal((await model('Fee').findOne({ student: u.Sara._id, batch: S.weekend }).lean()).billingPeriod, 'one-time');
  const ali = await model('BatchEnrollment').findOne({ batch: S.evening, student: u.Ali._id });
  expect(await api('Ali', 'POST', `/academy/enrollments/${ali._id}/transfer`, { toBatch: S.weekend }), 200, 'evening → weekend');
  assert.equal((await model('BatchEnrollment').findById(ali._id).lean()).status, 'transferred');
  assert.equal((await model('BatchEnrollment').findOne({ batch: S.weekend, student: u.Ali._id }).lean()).status, 'active');
  assert.ok(await model('Enrollment').exists({ student: u.Ali._id, course: S.course, status: 'active' }), 'still enrolled in the course');
  const teach = await api('Tutor', 'GET', '/academy/teaching');
  assert.equal(teach.body.data.length, 2);
  const ros = await api('Tutor', 'GET', `/academy/batches/${S.weekend}/students`);
  expect(ros, 200, 'the batch teacher sees the roster');
  assert.equal(ros.body.data.students.filter((s) => s.status === 'active').length, 2);
  expect(await api('Zain', 'GET', `/academy/batches/${S.weekend}/students`), 403);
  const kid = await api('Mom', 'GET', `/academy/children/${u.Ali._id}`);
  assert.ok(kid.body.data.some((x) => x.batch.name === 'Weekend B' && x.status === 'active'), 'parent sees the child\'s batch');
  expect(await api('Mom', 'GET', `/academy/children/${u.Sara._id}`), 404, 'not her child');
  const rep = await api('Owner', 'GET', `/academy/institutions/${S.academy._id}/report`);
  assert.equal(rep.body.data.totals.students, 3);
  assert.ok(rep.body.data.totals.billed > 0);
  const remove = await model('BatchEnrollment').findOne({ batch: S.weekend, student: u.Sara._id });
  expect(await api('Owner', 'POST', `/academy/enrollments/${remove._id}/remove`), 422, 'reason needed');
  expect(await api('Owner', 'POST', `/academy/enrollments/${remove._id}/remove`, { reason: 'Fees unpaid for 3 months' }), 200);
});

test('completing a batch completes its students\' course enrolment', async () => {
  expect(await api('Owner', 'PATCH', `/academy/batches/${S.weekend}`, { seats: 0 }), 422);
  expect(await api('Owner', 'PATCH', `/academy/batches/${S.weekend}`, { status: 'completed' }), 200);
  assert.equal((await model('BatchEnrollment').findOne({ batch: S.weekend, student: u.Ali._id }).lean()).status, 'completed');
  assert.ok(await model('Enrollment').exists({ student: u.Ali._id, course: S.course, status: 'completed' }));
  expect(await api('Zain', 'POST', `/academy/batches/${S.weekend}/join`), 409, 'a finished batch takes nobody');
});
