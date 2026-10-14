const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Independent teacher ↔ student ↔ parent, with no institution anywhere (master spec 9.18 and
// Part 10 §4): own course, consent-based enrolment (guardian approval for minors), attendance,
// homework, results, the parent's view, messaging, rating, meetings, revocation and isolation.
// Real HTTP through src/app, so the account gate, permissions and validation all apply.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (to, msg) => { sent.push({ to: String(to), title: msg.title }); return {}; });
mock.method(notifications, 'notifyAdmins', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 300)}`);
const data = (res) => res.body?.data;

async function account(name, role, extra = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@indie.test`, passwordHash: 'x', emailVerified: true, roles: [role], ...extra });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const m of ['TeacherStudentLink', 'Enrollment', 'ParentChildLink', 'TeacherFeedback', 'ParentTeacherMeeting']) await model(m).init();
  await account('Tutor', 'teacher');
  await account('OtherTutor', 'teacher');
  await account('Adult', 'student');
  await account('Minor', 'student');
  await account('Mother', 'parent');
  await account('Stranger', 'parent');
  await model('TeacherProfile').create({ user: u.Tutor._id, independent: true, verificationStatus: 'approved', subjects: ['Mathematics'] });
  await model('TeacherProfile').create({ user: u.OtherTutor._id, independent: true, verificationStatus: 'approved' });
  await model('StudentProfile').create({ user: u.Adult._id, dateOfBirth: new Date('2000-01-01') });
  await model('StudentProfile').create({ user: u.Minor._id, dateOfBirth: new Date('2012-05-01') });
  await model('ParentChildLink').create({ parent: u.Mother._id, student: u.Minor._id, status: 'approved', relationship: 'mother', requestedBy: u.Mother._id });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('1. independent teacher creates their own course (no institution)', async () => {
  const r = await api('Tutor', 'POST', '/courses', { title: 'O-Level Maths Tuition', subject: 'Mathematics', level: 'O-Level', isFree: false, price: 5000, currency: 'PKR' });
  expect(r, 201, 'create course');
  S.course = data(r);
  assert.equal(S.course.institution, null);
});

test('2. invitations: adult activates on acceptance; minor needs their own guardian', async () => {
  let r = await api('Tutor', 'POST', '/teacher-students/invite', { studentEmail: u.Adult.email, courseId: S.course._id, feeAmount: 5000, feeCurrency: 'PKR' });
  expect(r, 201, 'invite adult');
  S.adultLink = data(r);
  expect(await api('Tutor', 'POST', '/teacher-students/invite', { studentEmail: u.Adult.email, courseId: S.course._id }), 409, 'duplicate invite');
  expect(await api('OtherTutor', 'POST', '/teacher-students/invite', { studentEmail: u.Adult.email, courseId: S.course._id }), 403, 'invite to someone else’s course');
  expect(await api('Minor', 'PATCH', `/teacher-students/${S.adultLink._id}/respond`, { decision: 'accepted' }), 403, 'accept someone else’s invite');
  r = await api('Adult', 'PATCH', `/teacher-students/${S.adultLink._id}/respond`, { decision: 'accepted' });
  expect(r, 200, 'adult accepts');
  assert.equal(data(r).status, 'active');

  r = await api('Tutor', 'POST', '/teacher-students/invite', { studentEmail: u.Minor.email, courseId: S.course._id, feeAmount: 4000, feeCurrency: 'PKR' });
  expect(r, 201, 'invite minor');
  S.minorLink = data(r);
  r = await api('Minor', 'PATCH', `/teacher-students/${S.minorLink._id}/respond`, { decision: 'accepted' });
  assert.equal(data(r).status, 'consent_pending');
  assert.ok(sent.some((n) => n.to === String(u.Mother._id) && /Guardian approval/.test(n.title)), 'mother notified');
  expect(await api('Stranger', 'PATCH', `/teacher-students/${S.minorLink._id}/guardian-approve`, { approved: true }), 403, 'stranger approves');
  r = await api('Mother', 'GET', '/teacher-students/pending-guardian-approval');
  expect(r, 200);
  assert.equal(data(r).length, 1);
  r = await api('Mother', 'PATCH', `/teacher-students/${S.minorLink._id}/guardian-approve`, { approved: true });
  expect(r, 200, 'mother approves');
  assert.equal(data(r).status, 'active');
  assert.equal(await model('Enrollment').countDocuments({ course: S.course._id }), 2);
});

test('3. teacher runs the class: attendance, homework, grading and a result', async () => {
  let r = await api('Tutor', 'POST', '/teachers/me/attendance', { course: S.course._id, date: '2026-10-01', records: [{ student: u.Adult._id, status: 'present' }, { student: u.Minor._id, status: 'absent' }] });
  assert.ok([200, 201].includes(r.status), 'attendance');
  expect(await api('OtherTutor', 'POST', '/teachers/me/attendance', { course: S.course._id, date: '2026-10-02', records: [{ student: u.Minor._id, status: 'present' }] }), 403, 'other teacher attendance');

  r = await api('Tutor', 'POST', `/courses/${S.course._id}/assignments`, { title: 'Quadratics worksheet', description: 'Solve 1-10', maxMarks: 20, dueDate: new Date(Date.now() + 3 * 864e5) });
  expect(r, 201, 'assignment');
  S.assignment = data(r);
  r = await api('Minor', 'POST', `/courses/assignments/${S.assignment._id}/submit`, { text: 'My answers' });
  expect(r, 201, 'minor submits');
  S.submission = data(r);
  expect(await api('Tutor', 'PATCH', `/courses/submissions/${S.submission._id}/grade`, { marksObtained: 15, feedback: 'Good work' }), 200, 'grade');

  r = await api('Tutor', 'POST', `/courses/${S.course._id}/results`, { student: u.Minor._id, term: 'October test', marksObtained: 38, totalMarks: 50 });
  expect(r, 201, 'result');
});

test('4. student sees their tutoring, homework and result', async () => {
  let r = await api('Minor', 'GET', '/teacher-students/as-student');
  expect(r, 200);
  assert.equal(data(r)[0].status, 'active');
  r = await api('Minor', 'GET', `/courses/${S.course._id}/assignments`);
  expect(r, 200, 'student assignments');
  assert.ok(data(r).some((a) => a.title === 'Quadratics worksheet'));
  r = await api('Minor', 'GET', '/students/me/results');
  expect(r, 200, 'student results');
  assert.ok(JSON.stringify(data(r)).includes('October test'), 'result visible to student');
});

test('5. parent sees the child’s independent tutoring: teacher, attendance, homework, results, fee', async () => {
  const id = u.Minor._id;
  let r = await api('Mother', 'GET', `/parents/children/${id}/attendance`);
  expect(r, 200, 'parent attendance');
  assert.ok(JSON.stringify(data(r)).includes('absent'), 'absence visible to parent');
  r = await api('Mother', 'GET', `/parents/children/${id}/homework`);
  expect(r, 200, 'parent homework');
  assert.ok(JSON.stringify(data(r)).includes('Quadratics worksheet'), 'homework visible to parent');
  r = await api('Mother', 'GET', `/parents/children/${id}/results`);
  expect(r, 200, 'parent results');
  assert.ok(JSON.stringify(data(r)).includes('October test'), 'result visible to parent');
  r = await api('Mother', 'GET', `/parents/children/${id}/teachers`);
  expect(r, 200, 'parent teachers');
  assert.ok(JSON.stringify(data(r)).includes('Tutor'), 'independent teacher listed for parent');
  r = await api('Mother', 'GET', `/parents/children/${id}/fees`);
  expect(r, 200, 'parent fees');
  assert.ok(JSON.stringify(data(r)).includes('4000'), 'tuition fee visible to parent');
});

test('6. parent talks to the tutor: message, rating and meeting request', async () => {
  let r = await api('Mother', 'POST', '/messages', { to: String(u.Tutor._id), text: 'Assalam o alaikum, how is my daughter doing?' });
  expect(r, 201, 'parent → tutor message');
  r = await api('Tutor', 'POST', '/messages', { to: String(u.Mother._id), text: 'She is improving well.' });
  expect(r, 201, 'tutor → parent reply');
  expect(await api('Stranger', 'POST', '/messages', { to: String(u.Tutor._id), text: 'Hi' }), 403, 'stranger messages tutor');

  r = await api('Mother', 'POST', `/teacher-feedback/${u.Tutor._id}`, { rating: 5, comment: 'Very caring tutor' });
  assert.ok([200, 201].includes(r.status), `parent rates tutor → ${JSON.stringify(r.body).slice(0, 200)}`);
  expect(await api('Stranger', 'POST', `/teacher-feedback/${u.Tutor._id}`, { rating: 1 }), 403, 'stranger rates');

  r = await api('Mother', 'POST', '/ptm', { teacherId: String(u.Tutor._id), studentId: String(u.Minor._id), requestedDate: new Date(Date.now() + 2 * 864e5).toISOString(), mode: 'video', notes: 'Progress discussion' });
  assert.ok([200, 201].includes(r.status), `parent requests meeting with tutor → ${JSON.stringify(r.body).slice(0, 250)}`);
});

test('7. guardian revokes: tutor loses access to the child', async () => {
  expect(await api('Stranger', 'POST', `/teacher-students/${S.minorLink._id}/revoke`, { reason: 'x' }), 403, 'stranger revokes');
  expect(await api('Mother', 'POST', `/teacher-students/${S.minorLink._id}/revoke`, { reason: 'Moving to another tutor' }), 200, 'mother revokes');
  const r = await api('Tutor', 'POST', '/teachers/me/attendance', { course: S.course._id, date: '2026-10-05', records: [{ student: u.Minor._id, status: 'present' }] });
  assert.ok(r.status >= 400, `attendance for a revoked student must be refused → ${r.status}`);
  const roster = await api('Tutor', 'GET', '/teacher-students/mine');
  assert.equal(data(roster).find((l) => l._id === S.minorLink._id).status, 'removed');
});

test('8. isolation: unrelated parent and teacher see nothing of the child', async () => {
  for (const path of ['attendance', 'results', 'homework', 'fees']) {
    const r = await api('Stranger', 'GET', `/parents/children/${u.Minor._id}/${path}`);
    assert.ok([403, 404].includes(r.status), `stranger ${path} → ${r.status}`);
  }
  const r = await api('OtherTutor', 'GET', `/courses/${S.course._id}/students`);
  assert.ok([403, 404].includes(r.status), `other tutor roster → ${r.status}`);
});

test('9. parent pays the tuition fee: everyone is told who paid; both lists show it as paid by the mother', async () => {
  const { handleTutoringFeePaddleCompleted } = require('../src/controllers/webhook.controller');
  const link = await model('TeacherStudentLink').findById(S.minorLink._id);
  // The revoke in step 7 ended this link; a paid fee is still shown, so reactivate for the payment.
  // PKR is not a Paddle currency, so checkout charged the USD equivalent (as createFeeCheckout does).
  link.status = 'active'; link.paddleTransactionId = 'txn_mother_pays'; link.paddleAmount = 14.4; link.paddleCurrency = 'USD'; await link.save();
  sent.length = 0;
  await handleTutoringFeePaddleCompleted({
    id: 'txn_mother_pays', status: 'completed', currency_code: 'USD',
    custom_data: { kind: 'tutoring_fee', linkId: String(link._id), studentId: String(u.Minor._id), payerId: String(u.Mother._id) },
    items: [{ quantity: 1, price: { unit_price: { amount: '1440', currency_code: 'USD' } } }]
  });
  const paid = await model('TeacherStudentLink').findById(link._id);
  assert.equal(String(paid.feePaidBy), String(u.Mother._id));
  assert.equal(paid.feePaidByRole, 'Mother');
  const to = (who) => sent.filter((n) => n.to === String(u[who]._id)).map((n) => n.title);
  assert.ok(to('Mother').some((t) => /Payment successful/.test(t)), 'mother gets a confirmation');
  assert.ok(to('Minor').some((t) => /Fee paid/.test(t)), 'student told');
  assert.ok(to('Tutor').some((t) => /Fee paid/.test(t)), 'tutor told');

  for (const [who, path] of [['Mother', `/parents/children/${u.Minor._id}/fees`], ['Minor', '/students/me/fees']]) {
    const r = await api(who, 'GET', path);
    expect(r, 200, `${who} fees`);
    const row = data(r).find((f) => f.kind === 'tutoring');
    assert.equal(row.status, 'paid', `${who} sees paid`);
    assert.deepEqual([row.paidByInfo.name, row.paidByInfo.role], ['Mother', 'Mother'], `${who} sees who paid`);
  }
});

test('10. institution fee: parent reports, student cannot double-pay, school verifies, all told who paid', async () => {
  await account('Principal', 'institution_owner');
  const school = await model('Institution').create({ name: 'Fee School', slug: 'fee-school', type: 'school', country: 'PK', owner: u.Principal._id, verificationStatus: 'approved' });
  const fee = await model('Fee').create({ institution: school._id, student: u.Minor._id, recordedBy: u.Principal._id, title: 'October tuition', amount: 3000, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 5 * 864e5) });
  let r = await api('Mother', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 3000, method: 'cash', reference: 'CASH-77' });
  expect(r, 200, 'mother reports payment');
  expect(await api('Minor', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 3000, method: 'cash', reference: 'CASH-78' }), 409, 'second report while pending');
  sent.length = 0;
  r = await api('Principal', 'PATCH', `/institution-fees/fees/${fee._id}/verify-payment`, { decision: 'verify' });
  expect(r, 200, 'school verifies');
  r = await api('Mother', 'GET', `/parents/children/${u.Minor._id}/fees`);
  const row = data(r).find((f) => f._id === String(fee._id));
  assert.equal(row.status, 'paid');
  assert.deepEqual([row.paidByInfo.name, row.paidByInfo.role], ['Mother', 'Mother']);
  assert.equal(row.paymentHistory[0].paidByInfo.role, 'Mother');
  r = await api('Minor', 'GET', '/students/me/fees');
  assert.equal(data(r).find((f) => f._id === String(fee._id)).paidByInfo.role, 'Mother');
  expect(await api('Mother', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 1, method: 'cash', reference: 'X' }), 400, 'pay a paid fee');
});
