const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Every way a fee gets paid, by the student or a parent: who paid shows on each instalment,
// everyone is told, only what is owed is charged, and money for an already-paid fee is never lost.
process.env.NODE_ENV = 'test';
// These tests cover the online checkouts, which are switched off in production for now.
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (to, msg) => { sent.push({ to: String(to), title: msg.title, body: msg.body || '' }); return {}; });
mock.method(notifications, 'notifyAdmins', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const settlement = require('../src/services/feeSettlement.service');
const { applyOutcome } = require('../src/controllers/jazzcash.controller');
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
// A JazzCash checkout for `amount` by `payer`, then JazzCash confirming it (000). Re-using an id
// replays the same confirmation, as a repeated return/IPN would.
async function jazzcash(ref, payer, amount, refs) {
  if (!(await model('JazzCashPayment').exists({ txnRefNo: ref }))) {
    await model('JazzCashPayment').create({ txnRefNo: ref, payer: u[payer]._id, amountPaisa: amount * 100, amount, currency: 'PKR', ...refs });
  }
  return applyOutcome(ref, { code: '000', rrn: ref });
}
const payOnline = (fee, id, payer, amount) => jazzcash(id, payer, amount, { kind: 'fee', fee: fee._id });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const m of ['Fee', 'ParentChildLink', 'TeacherStudentLink']) await model(m).init();
  await account('Owner', 'institution_owner');
  await account('CareerZ', 'super_admin');
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
  await model('Fee').updateOne({ _id: fee._id }, { $set: { status: 'partially_paid', paidAmount: 2000, outstandingAmount: fee.amount - 2000 }, $push: { paymentHistory: { amount: 2000, method: 'bank_transfer', transactionId: 'MP-EARLIER-2000', verificationStatus: 'verified', verifiedAt: new Date(), recordedBy: u.Mum._id } } });
  let fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'partially_paid');
  assert.equal(settlement.assertPayableOnline(fresh), 3000, 'online checkout charges only the remaining 3000');

  sent.length = 0;
  await payOnline(fee, 'txn_rest', 'Kid', 3000);
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
  await payOnline(fee, 'txn_first', 'Mum', 1000);
  sent.length = 0;
  await payOnline(fee, 'txn_second', 'Dad', 1000);
  let fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.paidAmount, 1000);
  assert.equal(fresh.paymentHistory.length, 2);
  assert.deepEqual([fresh.refund.status, fresh.refund.amount, fresh.refund.duplicate], ['requested', 1000, true]);
  assert.ok(to('Owner').some((n) => /Duplicate fee payment — refund due/.test(n.title)));
  assert.ok(to('Dad').some((n) => /Second payment received/.test(n.title)));

  await payOnline(fee, 'txn_second', 'Dad', 1000);
  assert.equal((await model('Fee').findById(fee._id)).paymentHistory.length, 2, 'repeated JazzCash confirmation ignored');

  sent.length = 0;
  expect(await api('Owner', 'PATCH', `/institutions/fees/${fee._id}/refund/decide`, { decision: 'refunded' }), 200, 'school refunds the duplicate');
  fresh = await model('Fee').findById(fee._id);
  assert.equal(fresh.status, 'paid', 'refunding a duplicate keeps the real payment');
  for (const who of ['Kid', 'Mum', 'Dad']) assert.ok(to(who).some((n) => /Refund refunded/.test(n.title)), `${who} told about the refund`);
});

test('checkout opened before someone else paid part: only what is owed counts, the extra becomes a refund', async () => {
  const fee = await newFee(1000);
  await model('Fee').updateOne({ _id: fee._id }, { $set: { status: 'partially_paid', paidAmount: 400, outstandingAmount: fee.amount - 400 }, $push: { paymentHistory: { amount: 400, method: 'bank_transfer', transactionId: 'MP-EARLIER-400', verificationStatus: 'verified', verifiedAt: new Date(), recordedBy: u.Mum._id } } });
  await payOnline(fee, 'txn_full_late', 'Kid', 1000);
  const fresh = await model('Fee').findById(fee._id);
  assert.deepEqual([fresh.status, fresh.paidAmount, fresh.outstandingAmount], ['paid', 1000, 0]);
  assert.deepEqual([fresh.refund.status, fresh.refund.amount], ['requested', 400], '1000 paid online, 600 was owed: 400 back');
});

test('tuition paid twice (student and parent at once): the second is kept for refund and the tutor is told', async () => {
  const course = await model('Course').create({ title: 'Physics tuition', teacher: u.Tutor._id });
  const link = await model('TeacherStudentLink').create({ teacher: u.Tutor._id, student: u.Kid._id, course: course._id, status: 'active', feeAmount: 3000, feeCurrency: 'PKR' });
  const pay = (id, payer) => jazzcash(id, payer, 3000, { kind: 'tutoring_fee', tutoringLink: link._id });
  await pay('tx_kid', 'Kid');
  sent.length = 0;
  await pay('tx_mum', 'Mum');
  const fresh = await model('TeacherStudentLink').findById(link._id);
  assert.equal(fresh.feePaidByRole, 'Student');
  assert.equal(fresh.extraPayments.length, 1);
  assert.ok(to('Tutor').some((n) => /please refund/.test(n.title)));
  assert.ok(to('Mum').some((n) => /Second tuition payment/.test(n.title)));
});
