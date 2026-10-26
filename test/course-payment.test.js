const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Course checkout is JazzCash only: nothing is enrolled until a signed, matching JazzCash
// confirmation arrives, and a USD-priced course is charged in converted PKR.
process.env.NODE_ENV = 'test';
// These tests cover the online checkouts, which are switched off in production for now.
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.JAZZCASH_MERCHANT_ID = 'MC_COURSE';
process.env.JAZZCASH_PASSWORD = 'course-password';
process.env.JAZZCASH_INTEGRITY_SALT = 'course-salt';
process.env.JAZZCASH_RETURN_URL = '';
process.env.JAZZCASH_DEBUG = 'false';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Currency = require('../src/models/Currency');
const Enrollment = require('../src/models/Enrollment');
const CoursePurchase = require('../src/models/CoursePurchase');
const JazzCashPayment = require('../src/models/JazzCashPayment');
const jazzCash = require('../src/services/jazzcash.service');
const ctrl = require('../src/controllers/jazzcash.controller');

const models = [User, Course, Currency, Enrollment, CoursePurchase, JazzCashPayment];
let database, student, teacher, course;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  [student, teacher] = await User.create([
    { fullName: 'Student', email: 'student@course.test', passwordHash: 'unused' },
    { fullName: 'Teacher', email: 'teacher@course.test', passwordHash: 'unused' }
  ]);
  await Currency.create([
    { name: 'US Dollar', code: 'USD', symbol: '$', exchangeRateToUSD: 1 },
    { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 }
  ]);
  course = await Course.create({ title: 'Paid Course', teacher: teacher._id, published: true, isFree: false, price: 25, currency: 'USD' });
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
function signedReturn(checkout, overrides = {}) {
  const fields = {
    pp_Amount: checkout.fields.pp_Amount, pp_MerchantID: 'MC_COURSE', pp_ResponseCode: '000', pp_ResponseMessage: 'Success',
    pp_RetreivalReferenceNo: 'RRN_COURSE', pp_TxnCurrency: 'PKR', pp_TxnRefNo: checkout.txnRefNo, pp_Version: '1.1', ...overrides
  };
  fields.pp_SecureHash = jazzCash.secureHash(fields);
  return fields;
}

test('a USD course is charged in PKR and enrolls once, only after a signed matching confirmation', async () => {
  const checkout = (await invoke(ctrl.createCourseCheckout, { params: { courseId: course.id } })).body.data;
  assert.equal(checkout.fields.pp_Amount, String(Math.round((25 / 0.0036) * 100)), 'USD 25 converted to paisa');
  assert.equal(await Enrollment.countDocuments({}), 0, 'opening checkout enrolls nobody');

  await invoke(ctrl.handleReturn, { body: signedReturn(checkout, { pp_Amount: '100' }), user: undefined });
  assert.equal(await Enrollment.countDocuments({}), 0, 'a different amount is ignored');
  await invoke(ctrl.handleReturn, { body: { ...signedReturn(checkout), pp_SecureHash: 'F'.repeat(64) }, user: undefined });
  assert.equal(await Enrollment.countDocuments({}), 0, 'a forged signature is ignored');

  const body = signedReturn(checkout);
  await invoke(ctrl.handleReturn, { body, user: undefined });
  await invoke(ctrl.handleIpn, { body });
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);
  const purchase = await CoursePurchase.findOne({ providerCheckoutId: checkout.txnRefNo });
  assert.deepEqual([purchase.status, purchase.currency, purchase.gatewayCurrency], ['paid', 'USD', 'PKR']);
});

test('invalid price or an existing enrollment cannot open a checkout', async () => {
  await Enrollment.create({ course: course._id, student: student._id });
  await assert.rejects(invoke(ctrl.createCourseCheckout, { params: { courseId: course.id } }), { statusCode: 409 });
  await Enrollment.deleteMany({});
  course.price = 0;
  await course.save();
  await assert.rejects(invoke(ctrl.createCourseCheckout, { params: { courseId: course.id } }), { statusCode: 422 });
  assert.equal(await JazzCashPayment.countDocuments({}), 0);
});
