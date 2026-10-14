const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Every way a fee gets paid, by the student or a parent: who paid shows on each instalment,
// everyone is told, only what is owed is charged, and money for an already-paid fee is never lost.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (to, msg) => { sent.push({ to: String(to), title: msg.title, body: msg.body || '' }); return {}; });
mock.method(notifications, 'notifyAdmins', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const settlement = require('../src/services/feeSettlement.service');
const { handleFeePaddleCompleted, handleTutoringFeePaddleCompleted } = require('../src/controllers/webhook.controller');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 300)}`);
const to = (who) => sent.filter((n) => n.to === String(u[who]._id));
async function account(name, role) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@fees.test`, passwordHash: 'x', emailVerified: true, roles: [role] });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const newFee = (amount, extra = {}) => model('Fee').create({ institution: school._id, student: u.Kid._id, recordedBy: u.Owner._id, title: `Fee ${amount}`, amount, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 5 * 864e5), ...extra });
const paddle = (fee, id, payer, amount) => handleFeePaddleCompleted({ id, status: 'completed', custom_data: { kind: 'fee', feeId: String(fee._id), payerId: String(u[payer]._id), feeAmount: String(amount) } });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const m of ['Fee', 'ParentChildLink', 'TeacherStudentLink']) await model(m).init();
  await account('Owner', 'institution_owner');
  await account('Kid', 'student');
  await account('Mum', 'parent');
  await account('Dad', 'parent');
  await account('Tutor', 'teacher');
  school = await model('Institution').create({ name: 'Pay School', slug: 'pay-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved' });
  await model('ParentChildLink').create({ parent: u.Mum._id, student: u.Kid._id, status: 'approved', relationship: 'mother', requestedBy: u.Mum._id });
  await model('ParentChildLink').create({ parent: u.Dad._id, student: u.Kid._id, status: 'approved', relationship: 'father', requestedBy: u.Dad._id });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('mother pays part by bank, student pays the rest online: only the rest is charged; both instalments show their payer', async () => {
  const fee = await newFee(5000);
  expect(await api('Mum', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 2000, method: 'cash', reference: 'C-1' }), 200, 'mother reports 2000');
  let fresh = await model('Fee').findById(fee._id);
  assert.throws(() => settlement.assertPayableOnline(fresh), /awaiting the institution’s verification/, 'no online payment while one is pending');
  expect(await api('Owner', 'PATCH', `/institution-fees/fees/${fee._id}/verify-payment`, { decision: 'verify' }), 200, 'school verifies');
  fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'partially_paid');
  assert.equal(settlement.assertPayableOnline(fresh), 3000, 'online checkout charges only the remaining 3000');

  sent.length = 0;
  await paddle(fee, 'txn_rest', 'Kid', 3000);
  fresh = await model('Fee').findById(fee._id);
  assert.deepEqual([fresh.status, fresh.paidAmount, fresh.outstandingAmount], ['paid', 5000, 0]);
  assert.ok(fresh.receiptNumber, 'receipt issued once fully paid');
  assert.ok(to('Kid').some((n) => /Payment successful/.test(n.title)), 'student (payer) gets a confirmation');
  for (const who of ['Mum', 'Dad', 'Owner']) assert.ok(to(who).some((n) => /Fee paid/.test(n.title) && /paid by Kid \(Student\)/.test(n.body)), `${who} told the student paid`);

  const r = await api('Dad', 'GET', `/parents/children/${u.Kid._id}/fees`);
  const row = r.body.data.find((f) => f._id === String(fee._id));
  assert.deepEqual(row.paymentHistory.map((h) => [h.amount, h.paidByInfo?.role]), [[2000, 'Mother'], [3000, 'Student']]);
  assert.equal(row.paidByInfo.role, 'Student');
});

test('a second online payment for a paid fee is recorded as a duplicate with a refund request, not lost; retries change nothing', async () => {
  const fee = await newFee(1000);
  await paddle(fee, 'txn_first', 'Mum', 1000);
  sent.length = 0;
  await paddle(fee, 'txn_second', 'Dad', 1000);
  let fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.paidAmount, 1000);
  assert.equal(fresh.paymentHistory.length, 2);
  assert.deepEqual([fresh.refund.status, fresh.refund.amount, fresh.refund.duplicate], ['requested', 1000, true]);
  assert.ok(to('Owner').some((n) => /Duplicate fee payment — refund due/.test(n.title)));
  assert.ok(to('Dad').some((n) => /Second payment received/.test(n.title)));

  await paddle(fee, 'txn_second', 'Dad', 1000);
  assert.equal((await model('Fee').findById(fee._id)).paymentHistory.length, 2, 'webhook retry ignored');

  sent.length = 0;
  expect(await api('Owner', 'PATCH', `/institutions/fees/${fee._id}/refund/decide`, { decision: 'refunded' }), 200, 'school refunds the duplicate');
  fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'paid', 'refunding a duplicate keeps the real payment');
  for (const who of ['Kid', 'Mum', 'Dad']) assert.ok(to(who).some((n) => /Refund refunded/.test(n.title)), `${who} told about the refund`);
});

test('checkout opened before someone else paid part: only what is owed counts, the extra becomes a refund', async () => {
  const fee = await newFee(1000);
  expect(await api('Mum', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 400, method: 'cash', reference: 'C-2' }), 200);
  expect(await api('Owner', 'PATCH', `/institution-fees/fees/${fee._id}/verify-payment`, { decision: 'verify' }), 200);
  await paddle(fee, 'txn_full_late', 'Kid', 1000);
  const fresh = await model('Fee').findById(fee._id);
  assert.deepEqual([fresh.status, fresh.paidAmount, fresh.outstandingAmount], ['paid', 1000, 0]);
  assert.deepEqual([fresh.refund.status, fresh.refund.amount], ['requested', 400], '1000 paid online, 600 was owed: 400 back');
});

test('paid at the counter and rejected reports: the student and both parents are told', async () => {
  const fee = await newFee(700);
  sent.length = 0;
  expect(await api('Owner', 'PATCH', `/institutions/fees/${fee._id}/pay`, { paidVia: 'Cash', reference: 'DESK-9' }), 200, 'school records cash');
  for (const who of ['Kid', 'Mum', 'Dad']) assert.ok(to(who).some((n) => /Fee paid/.test(n.title) && /at the institution/.test(n.body)), `${who} told about counter payment`);
  expect(await api('Mum', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 700, method: 'cash', reference: 'X' }), 400, 'cannot pay a paid fee');

  const other = await newFee(900);
  expect(await api('Dad', 'POST', `/institution-fees/fees/${other._id}/report-payment`, { amount: 900, method: 'cash', reference: 'C-3' }), 200);
  sent.length = 0;
  expect(await api('Owner', 'PATCH', `/institution-fees/fees/${other._id}/verify-payment`, { decision: 'reject', rejectionReason: 'Reference not found' }), 200);
  for (const who of ['Kid', 'Mum', 'Dad']) assert.ok(to(who).some((n) => /Payment rejected/.test(n.title) && /Father/.test(n.body) && /Reference not found/.test(n.body)), `${who} told about rejection`);
  expect(await api('Kid', 'POST', `/institution-fees/fees/${other._id}/report-payment`, { amount: 900, method: 'cash', reference: 'C-4' }), 200, 'can pay again after rejection');
});

test('tuition paid twice (student and parent at once): the second is kept for refund and the tutor is told', async () => {
  const course = await model('Course').create({ title: 'Physics tuition', teacher: u.Tutor._id });
  const link = await model('TeacherStudentLink').create({ teacher: u.Tutor._id, student: u.Kid._id, course: course._id, status: 'active', feeAmount: 3000, feeCurrency: 'PKR', paddleAmount: 10.8, paddleCurrency: 'USD' });
  const pay = (id, payer) => handleTutoringFeePaddleCompleted({ id, status: 'completed', currency_code: 'USD', custom_data: { kind: 'tutoring_fee', linkId: String(link._id), studentId: String(u.Kid._id), payerId: String(u[payer]._id) }, items: [{ quantity: 1, price: { unit_price: { amount: '1080', currency_code: 'USD' } } }] });
  await model('TeacherStudentLink').updateOne({ _id: link._id }, { paddleTransactionId: 'tx_kid' });
  await pay('tx_kid', 'Kid');
  await model('TeacherStudentLink').updateOne({ _id: link._id }, { paddleTransactionId: 'tx_mum' });
  sent.length = 0;
  await pay('tx_mum', 'Mum');
  const fresh = await model('TeacherStudentLink').findById(link._id);
  assert.equal(fresh.feePaidByRole, 'Student');
  assert.equal(fresh.extraPayments.length, 1);
  assert.ok(to('Tutor').some((n) => /please refund/.test(n.title)));
  assert.ok(to('Mum').some((n) => /Second tuition payment/.test(n.title)));
});
