const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Typed staff roles with real permissions, bulk class promotion/graduation, and teacher
// performance reviews with the teacher's actual record as evidence.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (to, msg) => { sent.push({ to: String(to), title: msg.title }); return {}; });
mock.method(notifications, 'notifyAdmins', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school, g7, g8;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@people.test`, passwordHash: 'x', emailVerified: true, roles: [role] });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const m of ['TeacherReview', 'StudentPromotion', 'Enrollment']) await model(m).init();
  for (const [n, r] of [['Owner', 'institution_owner'], ['Accounts', 'institution_staff'], ['Clerk', 'institution_staff'], ['Teach', 'teacher'], ['Ali', 'student'], ['Bina', 'student'], ['Chand', 'student'], ['Mum', 'parent']]) await account(n, r);
  school = await model('Institution').create({ name: 'People School', slug: 'people-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', staff: [{ user: u.Teach._id, role: 'teacher', permissions: [] }] });
  g7 = await model('ClassSection').create({ institution: school._id, name: 'Grade 7-A', academicYear: '2025-26' });
  g8 = await model('ClassSection').create({ institution: school._id, name: 'Grade 8-A', academicYear: '2026-27' });
  for (const n of ['Ali', 'Bina', 'Chand']) {
    await model('StudentProfile').create({ user: u[n]._id, primaryInstitution: school._id, classSection: g7._id, status: 'active' });
    await model('StudentInstitutionMembership').create({ student: u[n]._id, institution: school._id, status: 'active', isPrimary: true });
  }
  await model('ParentChildLink').create({ parent: u.Mum._id, student: u.Ali._id, status: 'approved', relationship: 'mother', requestedBy: u.Mum._id });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('staff roles come with real permissions; unknown roles/permissions are refused; owner can change them', async () => {
  let r = await api('Owner', 'GET', '/institutions/staff-roles');
  expect(r, 200, 'role catalogue');
  assert.ok(r.body.data.roles.some((x) => x.key === 'accountant' && x.permissions.includes('fee:manage')));
  r = await api('Owner', 'POST', `/institutions/${school._id}/staff`, { userId: String(u.Accounts._id), role: 'accountant' });
  expect(r, 200, 'add accountant');
  assert.deepEqual(r.body.data.staff.find((s) => String(s.user) === String(u.Accounts._id)).permissions, ['fee:manage']);
  expect(await api('Owner', 'POST', `/institutions/${school._id}/staff`, { userId: String(u.Clerk._id), role: 'wizard' }), 422, 'unknown role');
  expect(await api('Owner', 'POST', `/institutions/${school._id}/staff`, { userId: String(u.Clerk._id), role: 'registrar', permissions: ['god:mode'] }), 422, 'unknown permission');
  expect(await api('Owner', 'POST', `/institutions/${school._id}/staff`, { userId: String(new mongoose.Types.ObjectId()), role: 'registrar' }), 404, 'no such user');
  expect(await api('Owner', 'POST', `/institutions/${school._id}/staff`, { userId: String(u.Clerk._id), role: 'receptionist' }), 200, 'add clerk');

  // The accountant can now really manage fees: record a cash payment.
  const fee = await model('Fee').create({ institution: school._id, student: u.Ali._id, recordedBy: u.Owner._id, title: 'Term fee', amount: 1000, currency: 'PKR', status: 'pending' });
  expect(await api('Clerk', 'PATCH', `/institutions/fees/${fee._id}/pay`, { paidVia: 'Cash', reference: 'R1' }), 403, 'receptionist cannot take fees');
  expect(await api('Accounts', 'PATCH', `/institutions/fees/${fee._id}/pay`, { paidVia: 'Cash', reference: 'R1' }), 200, 'accountant takes fees');

  r = await api('Owner', 'PATCH', `/institutions/${school._id}/staff/${u.Clerk._id}`, { role: 'registrar' });
  expect(r, 200, 'change role');
  assert.deepEqual(r.body.data.staff.find((s) => String(s.user) === String(u.Clerk._id)).permissions, ['students:manage']);
  expect(await api('Accounts', 'PATCH', `/institutions/${school._id}/staff/${u.Clerk._id}`, { role: 'principal' }), 403, 'only the owner');
  expect(await api('Owner', 'PATCH', `/institutions/${school._id}/staff/${u.Teach._id}`, { role: 'accountant' }), 422, 'teachers change through employment');
});

test('promotion: registrar previews, holds one back, moves the rest; enrolments, record and families follow', async () => {
  const c7 = await model('Course').create({ title: 'Maths 7', teacher: u.Teach._id, institution: school._id, classSection: g7._id, published: true });
  const c8 = await model('Course').create({ title: 'Maths 8', teacher: u.Teach._id, institution: school._id, classSection: g8._id, published: true });
  for (const n of ['Ali', 'Bina', 'Chand']) await model('Enrollment').create({ student: u[n]._id, course: c7._id });
  await model('Result').create({ student: u.Chand._id, course: c7._id, institution: school._id, marksObtained: 20, totalMarks: 100, term: 'Final', recordedBy: u.Teach._id });

  expect(await api('Accounts', 'GET', `/institutions/${school._id}/promotions/preview?fromSection=${g7._id}`), 403, 'accountant cannot promote');
  let r = await api('Clerk', 'GET', `/institutions/${school._id}/promotions/preview?fromSection=${g7._id}`);
  expect(r, 200, 'preview');
  assert.equal(r.body.data.students.length, 3);
  assert.equal(r.body.data.students.find((s) => s.name === 'Chand').averagePercent, 20);

  sent.length = 0;
  r = await api('Clerk', 'POST', `/institutions/${school._id}/promotions`, { action: 'promote', fromSection: String(g7._id), toSection: String(g8._id), heldBack: [{ student: String(u.Chand._id), reason: 'Final result below pass mark' }] });
  expect(r, 201, 'promote');
  assert.equal(r.body.data.moved.length, 2);
  assert.equal(String((await model('StudentProfile').findOne({ user: u.Ali._id })).classSection), String(g8._id));
  assert.equal(String((await model('StudentProfile').findOne({ user: u.Chand._id })).classSection), String(g7._id), 'held back stays');
  assert.equal((await model('Enrollment').findOne({ student: u.Ali._id, course: c7._id })).status, 'completed', 'old course closed, history kept');
  assert.ok(await model('Enrollment').exists({ student: u.Ali._id, course: c8._id }), 'enrolled in next class');
  assert.ok(!(await model('Enrollment').exists({ student: u.Chand._id, course: c8._id })));
  assert.ok(sent.some((n) => n.to === String(u.Mum._id) && /Promoted to Grade 8-A/.test(n.title)), 'parent told');
  assert.ok(sent.some((n) => n.to === String(u.Chand._id) && /Staying in Grade 7-A/.test(n.title)));

  expect(await api('Clerk', 'POST', `/institutions/${school._id}/promotions`, { action: 'promote', fromSection: String(g7._id), toSection: String(g7._id) }), 422, 'same class');
  r = await api('Clerk', 'POST', `/institutions/${school._id}/promotions`, { action: 'graduate', fromSection: String(g8._id) });
  expect(r, 201, 'graduate grade 8');
  assert.equal((await model('StudentProfile').findOne({ user: u.Ali._id })).status, 'graduated');
  assert.equal((await model('StudentInstitutionMembership').findOne({ student: u.Ali._id })).status, 'graduated');
  r = await api('Owner', 'GET', `/institutions/${school._id}/promotions`);
  assert.deepEqual(r.body.data.map((p) => [p.action, p.movedCount]), [['graduate', 2], ['promote', 2]]);
});

test('teacher review: evidence shown, draft, share, teacher responds; only reviewers and the teacher see it', async () => {
  await model('StaffAttendance').create([
    { institution: school._id, staff: u.Teach._id, date: new Date('2026-10-01'), checkInAt: new Date('2026-10-01T08:00:00Z'), status: 'present' },
    { institution: school._id, staff: u.Teach._id, date: new Date('2026-10-02'), checkInAt: new Date('2026-10-02T09:00:00Z'), status: 'late' }
  ]);
  expect(await api('Clerk', 'GET', `/institutions/${school._id}/teachers/${u.Teach._id}/review-data`), 403, 'registrar has no staff:review');
  let r = await api('Owner', 'GET', `/institutions/${school._id}/teachers/${u.Teach._id}/review-data`);
  expect(r, 200, 'evidence');
  assert.deepEqual([r.body.data.evidence.checkIns, r.body.data.evidence.lateCheckIns], [2, 1]);
  assert.equal(r.body.data.evidence.classResults.averagePercent, 20);

  const ratings = { teaching: 4, studentResults: 3, punctuality: 3, communication: 5, professionalism: 5 };
  expect(await api('Owner', 'POST', `/institutions/${school._id}/teachers/${u.Teach._id}/reviews`, { period: '2026 Term 1', ratings: { teaching: 9 } }), 422, 'bad ratings');
  r = await api('Owner', 'POST', `/institutions/${school._id}/teachers/${u.Teach._id}/reviews`, { period: '2026 Term 1', ratings, strengths: 'Clear explanations', improvements: 'Arrive on time' });
  expect(r, 201, 'draft');
  assert.equal(r.body.data.overall, 4);
  expect(await api('Owner', 'POST', `/institutions/${school._id}/teachers/${u.Teach._id}/reviews`, { period: '2026 Term 1', ratings }), 409, 'one per period');
  const id = r.body.data._id;
  expect(await api('Teach', 'GET', '/institutions/teacher-reviews/mine'), 200);
  assert.equal((await api('Teach', 'GET', '/institutions/teacher-reviews/mine')).body.data.length, 0, 'draft not visible to teacher');

  sent.length = 0;
  r = await api('Owner', 'PATCH', `/institutions/${school._id}/reviews/${id}`, { share: true });
  expect(r, 200, 'share');
  assert.equal(r.body.data.evidence.lateCheckIns, 1, 'evidence frozen at sharing');
  assert.ok(sent.some((n) => n.to === String(u.Teach._id) && /Performance review/.test(n.title)));
  expect(await api('Owner', 'PATCH', `/institutions/${school._id}/reviews/${id}`, { strengths: 'changed' }), 409, 'shared is final');

  r = await api('Teach', 'GET', '/institutions/teacher-reviews/mine');
  assert.equal(r.body.data[0].overall, 4);
  expect(await api('Clerk', 'POST', `/institutions/teacher-reviews/${id}/respond`, { response: 'x' }), 404, 'not your review');
  r = await api('Teach', 'POST', `/institutions/teacher-reviews/${id}/respond`, { response: 'Thank you, I will work on punctuality.' });
  expect(r, 200, 'respond');
  assert.ok(r.body.data.acknowledgedAt);
});
