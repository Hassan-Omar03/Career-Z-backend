const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_course';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_course';
process.env.PADDLE_API_KEY = 'test-key';
process.env.PADDLE_WEBHOOK_SECRET = 'test-paddle-course';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const CoursePurchase = require('../src/models/CoursePurchase');
const WebhookEvent = require('../src/models/WebhookEvent');
const payment = require('../src/controllers/payment.controller');
const webhook = require('../src/controllers/webhook.controller');
const paddleService = require('../src/services/paddle.service');
const { getStripeClient } = require('../src/services/stripe.service');
const env = require('../src/config/env');

let database, student, teacher, course;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Course, Enrollment, CoursePurchase, WebhookEvent].map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  await Promise.all([User, Course, Enrollment, CoursePurchase, WebhookEvent].map((model) => model.deleteMany({})));
  [student, teacher] = await User.create([
    { fullName: 'Student', email: 'student@course.test', passwordHash: 'unused' },
    { fullName: 'Teacher', email: 'teacher@course.test', passwordHash: 'unused' }
  ]);
  course = await Course.create({ title: 'Paid Course', teacher: teacher._id, published: true,
    isFree: false, price: 25, currency: 'USD' });
});
function invoke(handler, { params = {}, user = student, body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(value) { resolve({ status, body: value }); return this; },
      send(value) { resolve({ status, body: value }); return this; }
    };
    Promise.resolve(handler({ params, user, body, headers }, res, reject)).catch(reject);
  });
}
function stripeRequest(checkout, id = 'evt_course') {
  const body = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: checkout } });
  return { body: Buffer.from(body), headers: {
    'stripe-signature': getStripeClient().webhooks.generateTestHeaderString({ payload: body, secret: env.stripe.webhookSecret })
  } };
}
function paddleRequest(transaction, id = 'evt_paddle_course') {
  const body = Buffer.from(JSON.stringify({ event_id: id, event_type: 'transaction.completed', data: transaction }));
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', env.paddle.webhookSecret).update(`${ts}:${body}`).digest('hex');
  return { body, headers: { 'paddle-signature': `ts=${ts};h1=${signature}` } };
}

test('Stripe checkout waits for signed paid event and enrolls once', async (t) => {
  t.mock.method(getStripeClient().checkout.sessions, 'create', async () => ({ id: 'cs_course', url: 'https://checkout.stripe.test/course' }));
  const result = await invoke(payment.createStripeCourseCheckout, { params: { courseId: course.id } });
  assert.equal(result.status, 200);
  assert.equal(await Enrollment.countDocuments({}), 0);
  const checkout = { id: 'cs_course', payment_status: 'paid', payment_intent: 'pi_course', currency: 'usd', amount_total: 2500,
    metadata: { kind: 'course', courseId: course.id, studentId: student.id } };
  assert.equal((await invoke(webhook.handleStripeWebhook, stripeRequest({ ...checkout, payment_status: 'unpaid' }, 'evt_unpaid'))).status, 200);
  assert.equal(await Enrollment.countDocuments({}), 0);
  assert.equal((await invoke(webhook.handleStripeWebhook, stripeRequest({ ...checkout, amount_total: 1 }, 'evt_wrong'))).status, 500);
  assert.equal(await Enrollment.countDocuments({}), 0);
  assert.equal((await invoke(webhook.handleStripeWebhook, stripeRequest(checkout))).status, 200);
  assert.equal((await invoke(webhook.handleStripeWebhook, stripeRequest(checkout))).body.duplicate, true);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);
  assert.equal((await CoursePurchase.findOne({ providerCheckoutId: 'cs_course' })).status, 'paid');
});

test('Paddle checkout and verified sync enroll once', async (t) => {
  t.mock.method(paddleService, 'createTransaction', async () => ({ id: 'txn_course', status: 'ready' }));
  const created = await invoke(payment.createPaddleCourseCheckout, { params: { courseId: course.id } });
  assert.equal(created.body.data.transactionId, 'txn_course');
  assert.equal(await Enrollment.countDocuments({}), 0);
  const transaction = { id: 'txn_course', status: 'completed', currency_code: 'USD',
    custom_data: { kind: 'course', courseId: course.id, studentId: student.id },
    items: [{ quantity: 1, price: { unit_price: { amount: '2500', currency_code: 'USD' } } }] };
  t.mock.method(paddleService, 'getTransaction', async () => transaction);
  const params = { courseId: course.id, transactionId: transaction.id };
  assert.equal((await invoke(payment.syncPaddleCourseStatus, { params })).body.data.status, 'paid');
  assert.equal((await invoke(webhook.handlePaddleWebhook, paddleRequest(transaction))).status, 200);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);
});

test('invalid price cannot create checkout', async () => {
  course.price = 0;
  await course.save();
  await assert.rejects(invoke(payment.createStripeCourseCheckout, { params: { courseId: course.id } }), { statusCode: 422 });
});
