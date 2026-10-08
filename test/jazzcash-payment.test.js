const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.JAZZCASH_MERCHANT_ID = 'MC_TEST';
process.env.JAZZCASH_PASSWORD = 'test-password';
process.env.JAZZCASH_INTEGRITY_SALT = 'test-salt';
process.env.CLIENT_URL = 'http://localhost:5173';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const User = require('../src/models/User');
const Fee = require('../src/models/Fee');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const CoursePurchase = require('../src/models/CoursePurchase');
const Currency = require('../src/models/Currency');
const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const JazzCashPayment = require('../src/models/JazzCashPayment');
const jazzCash = require('../src/services/jazzcash.service');
const ctrl = require('../src/controllers/jazzcash.controller');

const models = [User, Fee, Course, Enrollment, CoursePurchase, Currency, Wallet, WalletTransaction, JazzCashPayment];
let database, student, other, teacher;

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  [student, other, teacher] = await User.create([
    { fullName: 'Student', email: 'student@jazz.test', passwordHash: 'unused' },
    { fullName: 'Other', email: 'other@jazz.test', passwordHash: 'unused' },
    { fullName: 'Teacher', email: 'teacher@jazz.test', passwordHash: 'unused' }
  ]);
});

function invoke(handler, { params = {}, user = student, body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(value) { resolve({ status, body: value }); return this; },
      redirect(code, url) { resolve({ status: code, redirect: url }); return this; }
    };
    Promise.resolve(handler({ params, user, body, headers }, res, reject)).catch(reject);
  });
}

// What JazzCash's hosted page posts back to pp_ReturnURL, signed with the integrity salt.
function signedReturn(checkout, overrides = {}) {
  const fields = {
    pp_Amount: checkout.fields.pp_Amount, pp_BillReference: checkout.fields.pp_BillReference,
    pp_Language: 'EN', pp_MerchantID: 'MC_TEST', pp_ResponseCode: '000',
    pp_ResponseMessage: 'Thank you for Using JazzCash, your transaction was successful.',
    pp_RetreivalReferenceNo: '221127664009', pp_TxnCurrency: 'PKR', pp_TxnDateTime: checkout.fields.pp_TxnDateTime,
    pp_TxnRefNo: checkout.txnRefNo, pp_TxnType: 'MWALLET', pp_Version: '1.1', ...overrides
  };
  fields.pp_SecureHash = jazzCash.secureHash(fields);
  return fields;
}

const mkFee = (amount = 2500, currency = 'PKR') => Fee.create({
  student: student._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition Fee Term 1', amount, currency, recordedBy: teacher._id
});

test('secure hash: checkout fields verify, any tampering breaks the signature', () => {
  const fields = jazzCash.buildCheckoutFields({ txnRefNo: 'T2026100812000012345', amountPaisa: 250000, billReference: 'fee', description: 'Tuition' });
  assert.equal(fields.pp_MerchantID, 'MC_TEST');
  assert.equal(fields.pp_Amount, '250000');
  assert.match(fields.pp_SecureHash, /^[0-9A-F]{64}$/);
  assert.ok(jazzCash.verifySecureHash(fields));
  assert.equal(jazzCash.verifySecureHash({ ...fields, pp_Amount: '100' }), false);
  assert.equal(jazzCash.verifySecureHash({ ...fields, pp_SecureHash: '' }), false);
  assert.equal(jazzCash.newTxnRefNo().length, 20);
});

test('fee: a signed successful return marks the fee paid exactly once and redirects to the app', async () => {
  const fee = await mkFee();
  const checkout = (await invoke(ctrl.createFeeCheckout, { params: { feeId: fee.id } })).body.data;
  assert.equal(checkout.fields.pp_Amount, '250000');
  assert.equal((await Fee.findById(fee._id)).status, 'processing');

  const body = signedReturn(checkout);
  const first = await invoke(ctrl.handleReturn, { body, user: undefined });
  assert.equal(first.status, 303);
  assert.equal(first.redirect, `http://localhost:5173/dashboard?jazzcash=paid&ref=${checkout.txnRefNo}`);
  const paid = await Fee.findById(fee._id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paymentMethod, 'jazzcash');
  assert.equal(paid.transactionId, '221127664009');
  const receipt = paid.receiptNumber;

  await invoke(ctrl.handleReturn, { body, user: undefined }); // replayed return
  assert.equal((await Fee.findById(fee._id)).receiptNumber, receipt);
});

test('the payer returns to the frontend they started from, never to a non-allow-listed site', async () => {
  const deployed = await mkFee();
  const fromDeployed = (await invoke(ctrl.createFeeCheckout, { params: { feeId: deployed.id }, headers: { origin: 'https://career-z-zeta.vercel.app' } })).body.data;
  const back = await invoke(ctrl.handleReturn, { body: signedReturn(fromDeployed), user: undefined });
  assert.equal(back.redirect, `https://career-z-zeta.vercel.app/dashboard?jazzcash=paid&ref=${fromDeployed.txnRefNo}`);

  const other = await mkFee();
  const fromEvil = (await invoke(ctrl.createFeeCheckout, { params: { feeId: other.id }, headers: { origin: 'https://evil.example' } })).body.data;
  const fallback = await invoke(ctrl.handleReturn, { body: signedReturn(fromEvil), user: undefined });
  assert.match(fallback.redirect, /^http:\/\/localhost:5173\/dashboard\?/);
});

test('fee: forged signature or a different amount is ignored', async () => {
  const fee = await mkFee();
  const checkout = (await invoke(ctrl.createFeeCheckout, { params: { feeId: fee.id } })).body.data;
  const forged = { ...signedReturn(checkout), pp_SecureHash: 'A'.repeat(64) };
  assert.match((await invoke(ctrl.handleReturn, { body: forged, user: undefined })).redirect, /jazzcash=error/);
  const cheaper = signedReturn(checkout, { pp_Amount: '100' });
  assert.match((await invoke(ctrl.handleReturn, { body: cheaper, user: undefined })).redirect, /jazzcash=error/);
  assert.equal((await Fee.findById(fee._id)).status, 'processing');
});

test('fee: a failed payment restores the fee so it can be paid again', async () => {
  const fee = await mkFee();
  const checkout = (await invoke(ctrl.createFeeCheckout, { params: { feeId: fee.id } })).body.data;
  const result = await invoke(ctrl.handleReturn, { body: signedReturn(checkout, { pp_ResponseCode: '199', pp_ResponseMessage: 'Insufficient balance' }), user: undefined });
  assert.match(result.redirect, /jazzcash=failed/);
  assert.equal((await Fee.findById(fee._id)).status, 'pending');
});

test('fee: only the student or an approved guardian can start a checkout', async () => {
  const fee = await mkFee();
  await assert.rejects(invoke(ctrl.createFeeCheckout, { params: { feeId: fee.id }, user: other }), { statusCode: 403 });
});

test('fee: a voucher waits for over-the-counter payment, then sync settles it from JazzCash inquiry', async (t) => {
  const fee = await mkFee();
  const checkout = (await invoke(ctrl.createFeeCheckout, { params: { feeId: fee.id } })).body.data;
  const voucher = await invoke(ctrl.handleReturn, { body: signedReturn(checkout, { pp_ResponseCode: '124', pp_TxnType: 'OTC' }), user: undefined });
  assert.match(voucher.redirect, /jazzcash=awaiting_payment/);
  assert.equal((await Fee.findById(fee._id)).status, 'processing');

  t.mock.method(jazzCash, 'inquire', async () => ({ pp_ResponseCode: '000', pp_PaymentResponseCode: '000', pp_PaymentResponseMessage: 'Completed', pp_RetreivalReferenceNo: '991' }));
  const synced = await invoke(ctrl.syncPayment, { params: { txnRefNo: checkout.txnRefNo } });
  assert.equal(synced.body.data.status, 'paid');
  assert.equal((await Fee.findById(fee._id)).status, 'paid');
  await assert.rejects(invoke(ctrl.syncPayment, { params: { txnRefNo: checkout.txnRefNo }, user: other }), { statusCode: 404 });
});

test('course: paid return enrolls the student once', async () => {
  const course = await Course.create({ title: 'Paid Course', teacher: teacher._id, published: true, isFree: false, price: 1500, currency: 'PKR' });
  const checkout = (await invoke(ctrl.createCourseCheckout, { params: { courseId: course.id } })).body.data;
  assert.equal(checkout.fields.pp_Amount, '150000');
  const body = signedReturn(checkout);
  await invoke(ctrl.handleReturn, { body, user: undefined });
  await invoke(ctrl.handleReturn, { body, user: undefined });
  assert.equal(await Enrollment.countDocuments({ course: course._id, student: student._id }), 1);
  assert.equal((await CoursePurchase.findOne({ providerCheckoutId: checkout.txnRefNo })).status, 'paid');
});

test('wallet: top-up credits once; a non-PKR wallet converts the JazzCash charge to PKR', async () => {
  await Currency.create([
    { name: 'US Dollar', code: 'USD', symbol: '$', exchangeRateToUSD: 1 },
    { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 }
  ]);
  const checkout = (await invoke(ctrl.createWalletTopup, { body: { amount: 10, currency: 'USD' } })).body.data;
  assert.equal(checkout.fields.pp_Amount, String(Math.round((10 / 0.0036) * 100)));
  const body = signedReturn(checkout);
  await invoke(ctrl.handleReturn, { body, user: undefined });
  await invoke(ctrl.handleReturn, { body, user: undefined });
  const wallet = await Wallet.findOne({ user: student._id, currency: 'USD' });
  assert.equal(wallet.available, 10);
  assert.equal((await WalletTransaction.findOne({ reference: checkout.txnRefNo })).status, 'completed');
});

test('wallet: a failed top-up is rejected and never credits', async () => {
  const checkout = (await invoke(ctrl.createWalletTopup, { body: { amount: 500, currency: 'PKR' } })).body.data;
  await invoke(ctrl.handleReturn, { body: signedReturn(checkout, { pp_ResponseCode: '999' }), user: undefined });
  assert.equal(await Wallet.countDocuments({ user: student._id }), 0);
  assert.equal((await WalletTransaction.findOne({ reference: checkout.txnRefNo })).status, 'rejected');
});
