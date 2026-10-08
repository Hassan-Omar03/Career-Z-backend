const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.NOWPAYMENTS_API_KEY = 'test-nowpayments-key';
process.env.NOWPAYMENTS_IPN_SECRET = 'test-nowpayments-ipn-secret';

const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const WebhookEvent = require('../src/models/WebhookEvent');
const webhookCtrl = require('../src/controllers/webhook.controller');
const env = require('../src/config/env');

let mongo, student;
const models = [User, Wallet, WalletTransaction, WebhookEvent];

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { body, headers = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ body, headers }, res)).catch((err) => resolve({ status: 500, body: { message: err.message } }));
  });
}

function sign(body) {
  const sorted = Object.keys(body).sort().reduce((acc, key) => { acc[key] = body[key]; return acc; }, {});
  return crypto.createHmac('sha512', env.nowPayments.ipnSecret).update(JSON.stringify(sorted)).digest('hex');
}
function ipnRequest(payload) {
  return { body: payload, headers: { 'x-nowpayments-sig': sign(payload) } };
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  student = await User.create({ fullName: 'Crypto Student', email: 'crypto-student@test.local', passwordHash: 'x', roles: ['student'] });
  await Wallet.create({ user: student._id, currency: 'USD', available: 0 });
  await WalletTransaction.create({ user: student._id, type: 'topup', amount: 50, currency: 'USD', status: 'pending', nowPaymentsId: 'np_pay_1' });
});

test('a bad IPN signature is rejected before any processing', async () => {
  const payload = { payment_id: 'np_pay_1', payment_status: 'finished' };
  const request = { body: payload, headers: { 'x-nowpayments-sig': 'deadbeef' } };
  const res = await invoke(webhookCtrl.handleNowPaymentsWebhook, request);
  assert.equal(res.status, 400);
  assert.equal(await WebhookEvent.countDocuments({}), 0);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 0);
});

test('an intermediate status (waiting/confirming) never credits the wallet', async () => {
  const res = await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'np_pay_1', payment_status: 'waiting' }));
  assert.equal(res.status, 200);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 0);
  assert.equal((await WalletTransaction.findOne({ nowPaymentsId: 'np_pay_1' })).status, 'pending');
});

test('a finished payment credits the wallet exactly once, even with a retried duplicate IPN', async () => {
  const request = ipnRequest({ payment_id: 'np_pay_1', payment_status: 'finished' });
  const [first, second] = await Promise.all([
    invoke(webhookCtrl.handleNowPaymentsWebhook, request),
    invoke(webhookCtrl.handleNowPaymentsWebhook, request)
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 50);
  assert.equal(await WalletTransaction.countDocuments({ nowPaymentsId: 'np_pay_1', status: 'completed' }), 1);
  assert.equal(await WebhookEvent.countDocuments({}), 1);
});

test('waiting then finished for the same payment both get processed (status-scoped dedupe, not swallowed)', async () => {
  await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'np_pay_1', payment_status: 'waiting' }));
  await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'np_pay_1', payment_status: 'confirming' }));
  const finished = await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'np_pay_1', payment_status: 'finished' }));
  assert.equal(finished.status, 200);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 50);
  assert.equal(await WebhookEvent.countDocuments({}), 3);
});

test('a payment_id with no matching pending top-up fails cleanly, without crediting anything', async () => {
  const res = await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'no_such_payment', payment_status: 'finished' }));
  assert.equal(res.status, 500);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 0);
});

test('confirmed is intermediate and cannot credit a wallet before finished', async () => {
  const res = await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ payment_id: 'np_pay_1', payment_status: 'confirmed' }));
  assert.equal(res.status, 200);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 0);
});

test('new checkout snapshots reject wrong order, amount, currency and underpayment', async () => {
  await WalletTransaction.updateOne({ nowPaymentsId: 'np_pay_1' }, { $set: { gatewayOrderId: 'order-1', gatewayPriceAmount: 50, gatewayPriceCurrency: 'usd', gatewayPayCurrency: 'usdttrc20', gatewayPayAmount: 50 } });
  const valid = { payment_id: 'np_pay_1', payment_status: 'finished', order_id: 'order-1', price_amount: 50, price_currency: 'usd', pay_currency: 'usdttrc20', actually_paid: 50 };
  for (const overrides of [{ order_id: 'another' }, { price_amount: 1 }, { price_currency: 'eur' }, { pay_currency: 'btc' }, { actually_paid: 10 }]) {
    const result = await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest({ ...valid, ...overrides }));
    assert.equal(result.status, 500);
    assert.equal((await Wallet.findOne({ user: student._id })).available, 0);
  }
  assert.equal((await invoke(webhookCtrl.handleNowPaymentsWebhook, ipnRequest(valid))).status, 200);
  assert.equal((await Wallet.findOne({ user: student._id })).available, 50);
});

test('provider signature canonicalizes nested objects and arrays recursively', () => {
  const service = require('../src/services/nowpayments.service');
  const body = { payment_status: 'waiting', payment_id: 'np_pay_1', outcome: [{ z: 2, a: { y: 1, b: 0 } }] };
  const canonicalPayload = '{"outcome":[{"a":{"b":0,"y":1},"z":2}],"payment_id":"np_pay_1","payment_status":"waiting"}';
  const signature = crypto.createHmac('sha512', env.nowPayments.ipnSecret).update(canonicalPayload).digest('hex');
  assert.equal(service.verifyIpnSignature(body, signature), true);
  assert.equal(service.verifyIpnSignature({ ...body, outcome: [{ z: 3 }] }, signature), false);
});
