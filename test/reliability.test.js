const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Never use the developer's database, SMTP account or payment credentials.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'reliability-test-access-secret';
process.env.PADDLE_API_KEY = 'test-key';
process.env.PADDLE_WEBHOOK_SECRET = 'test-paddle-webhook-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_reliability';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_reliability';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const User = require('../src/models/User');
const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const WebhookEvent = require('../src/models/WebhookEvent');
const Fee = require('../src/models/Fee');
const Institution = require('../src/models/Institution');
const Setting = require('../src/models/Setting');
const wallet = require('../src/controllers/wallet.controller');
const webhook = require('../src/controllers/webhook.controller');
const { initSocket } = require('../src/realtime/socket');
const env = require('../src/config/env');
const { getStripeClient } = require('../src/services/stripe.service');

let database, server, io, origin, sender, recipient;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Wallet, WalletTransaction, WebhookEvent, Fee, Institution, Setting].map((model) => model.init()));
  server = http.createServer();
  io = initSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=polling`;
});
after(async () => {
  if (io) await new Promise((resolve) => io.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
});
beforeEach(async () => {
  await Promise.all([User, Wallet, WalletTransaction, WebhookEvent, Fee, Institution, Setting].map((model) => model.deleteMany({})));
  [sender, recipient] = await User.create([
    { fullName: 'Sender', email: 'sender@example.test', passwordHash: 'unused' },
    { fullName: 'Recipient', email: 'recipient@example.test', passwordHash: 'unused' }
  ]);
  await Wallet.create({ user: sender._id, currency: 'USD', available: 100 });
});

function invoke(handler, { body = {}, user = sender, params = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(value) { status = value; return this; },
      json(value) { resolve({ status, body: value }); return this; },
      send(value) { resolve({ status, body: value }); return this; }
    };
    try { Promise.resolve(handler({ body, user, params, headers, query: {} }, res, reject)).catch(reject); }
    catch (error) { reject(error); }
  });
}
function topup(id = 'txn_topup_test') {
  return {
    id, status: 'completed', currency_code: 'USD',
    custom_data: { kind: 'wallet_topup', userId: sender._id.toString(), currency: 'USD' },
    items: [{ quantity: 1, price: { unit_price: { amount: '2500', currency_code: 'USD' } } }]
  };
}
function paddleRequest(data, id = 'evt_test') {
  const body = Buffer.from(JSON.stringify({ event_id: id, event_type: 'transaction.completed', data }));
  const ts = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', env.paddle.webhookSecret).update(`${ts}:${body}`).digest('hex');
  return { body, headers: { 'paddle-signature': `ts=${ts};h1=${digest}` } };
}
async function handshake(auth) {
  const opening = await (await fetch(origin)).text();
  const sid = JSON.parse(opening.slice(1)).sid;
  const url = `${origin}&sid=${sid}`;
  await fetch(url, { method: 'POST', body: `40${JSON.stringify(auth)}` });
  const packet = await (await fetch(url)).text();
  return { packet, close: () => fetch(url, { method: 'POST', body: '1' }) };
}

test('socket rejects claimed user IDs and invalid/expired access tokens', async () => {
  for (const auth of [
    { userId: sender.id },
    { accessToken: 'invalid' },
    { accessToken: jwt.sign({ sub: sender.id }, env.jwt.accessSecret, { expiresIn: -1 }) }
  ]) {
    const connection = await handshake(auth);
    try { assert.match(connection.packet, /^44/); }
    finally { await connection.close(); }
  }
});
test('socket joins only the authenticated user room and rejects suspended accounts', async () => {
  const accessToken = jwt.sign({ sub: sender.id }, env.jwt.accessSecret, { expiresIn: '5m' });
  const connection = await handshake({ accessToken, userId: recipient.id });
  try {
    assert.match(connection.packet, /^40/);
    const socket = [...io.sockets.sockets.values()].find((item) => item.data.userId === sender.id);
    assert.ok(socket.rooms.has(`user:${sender.id}`));
    assert.equal(socket.rooms.has(`user:${recipient.id}`), false);
  } finally { await connection.close(); }
  await User.updateOne({ _id: sender._id }, { status: 'suspended' });
  const rejected = await handshake({ accessToken });
  try { assert.match(rejected.packet, /^44/); }
  finally { await rejected.close(); }
});
test('concurrent transfers cannot overspend and record both sides once', async () => {
  const request = { body: { recipientEmail: recipient.email, amount: 80 } };
  const results = await Promise.allSettled([invoke(wallet.transfer, request), invoke(wallet.transfer, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 20);
  assert.equal((await Wallet.findOne({ user: recipient._id })).available, 80);
  assert.equal(await WalletTransaction.countDocuments({}), 2);
});
test('ledger failure rolls back both transfer balances and the first ledger entry', async (t) => {
  const original = WalletTransaction.create.bind(WalletTransaction);
  let writes = 0;
  t.mock.method(WalletTransaction, 'create', (...args) => {
    if (++writes === 2) throw new Error('Injected second ledger failure');
    return original(...args);
  });
  await assert.rejects(invoke(wallet.transfer, { body: { recipientEmail: recipient.email, amount: 25 } }), /Injected/);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
  assert.equal(await Wallet.countDocuments({ user: recipient._id }), 0);
  assert.equal(await WalletTransaction.countDocuments({}), 0);
});
test('invalid monetary input never changes the ledger', async () => {
  for (const amount of ['10', {}, NaN, Infinity, -1, 0]) {
    await assert.rejects(invoke(wallet.transfer, { body: { recipientEmail: recipient.email, amount } }), { statusCode: 422 });
  }
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
});
test('withdrawal ledger failure restores the available and pending balances', async (t) => {
  t.mock.method(WalletTransaction, 'create', () => { throw new Error('Injected withdrawal ledger failure'); });
  await assert.rejects(invoke(wallet.requestWithdrawal, {
    body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'test account' }
  }), /Injected/);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});
test('concurrent withdrawal requests cannot reserve the same funds twice', async () => {
  const request = { body: { amount: 80, payoutMethod: 'bank_transfer', payoutDetails: 'test account' } };
  const results = await Promise.allSettled([invoke(wallet.requestWithdrawal, request), invoke(wallet.requestWithdrawal, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 20);
  assert.equal(balance.pending, 80);
  assert.equal(await WalletTransaction.countDocuments({ type: 'withdrawal' }), 1);
});
test('concurrent withdrawal reviews release reserved funds only once', async () => {
  const result = await invoke(wallet.requestWithdrawal, { body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'test account' } });
  const request = { body: { decision: 'rejected' }, params: { id: result.body.data.id } };
  const results = await Promise.allSettled([invoke(wallet.reviewWithdrawal, request), invoke(wallet.reviewWithdrawal, request)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});
test('signed duplicate webhooks and concurrent checkout sync credit a top-up once', async () => {
  const transaction = topup();
  const request = paddleRequest(transaction);
  const results = await Promise.all([
    invoke(webhook.handlePaddleWebhook, request), invoke(webhook.handlePaddleWebhook, request),
    webhook.handleWalletTopupCompleted(transaction)
  ]);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 125);
  assert.equal(await WalletTransaction.countDocuments({}), 1);
  assert.equal(await WebhookEvent.countDocuments({}), 1);
});
test('failed webhook returns 500, rolls back its receipt, and succeeds on retry', async (t) => {
  const failure = t.mock.method(Wallet, 'findOneAndUpdate', () => { throw new Error('Injected wallet failure'); });
  const request = paddleRequest(topup());
  const first = await invoke(webhook.handlePaddleWebhook, request);
  assert.equal(first.status, 500);
  assert.equal(await WebhookEvent.countDocuments({}), 0);
  assert.equal(await WalletTransaction.countDocuments({}), 0);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
  failure.mock.restore();
  assert.equal((await invoke(webhook.handlePaddleWebhook, request)).status, 200);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 125);
});
test('unpaid, wrong-purpose and currency-mismatched top-ups never credit', async () => {
  for (const transaction of [
    { ...topup(), status: 'ready' },
    { ...topup(), currency_code: 'EUR' },
    { ...topup(), custom_data: { ...topup().custom_data, kind: 'fee' } }
  ]) await assert.rejects(webhook.handleWalletTopupCompleted(transaction), { statusCode: 422 });
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
});
test('bad signatures are rejected before payment processing', async () => {
  const request = paddleRequest(topup());
  request.headers['paddle-signature'] = 'ts=invalid;h1=00';
  assert.equal((await invoke(webhook.handlePaddleWebhook, request)).status, 400);
  assert.equal(await WebhookEvent.countDocuments({}), 0);
});
test('Stripe failed settlement rolls back the fee and accepts a later retry', async (t) => {
  const fee = await Fee.create({ student: sender._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition', amount: 25, recordedBy: sender._id });
  const event = {
    id: 'evt_stripe_test', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test', payment_status: 'paid', metadata: { kind: 'fee', feeId: fee.id, payerId: sender.id } } }
  };
  const body = JSON.stringify(event);
  const request = { body: Buffer.from(body), headers: {
    'stripe-signature': getStripeClient().webhooks.generateTestHeaderString({ payload: body, secret: env.stripe.webhookSecret })
  } };
  const failure = t.mock.method(Institution, 'findById', () => { throw new Error('Injected post-save failure'); });
  assert.equal((await invoke(webhook.handleStripeWebhook, request)).status, 500);
  assert.equal((await Fee.findById(fee._id)).status, 'pending');
  assert.equal(await WebhookEvent.countDocuments({}), 0);
  failure.mock.restore();
  assert.equal((await invoke(webhook.handleStripeWebhook, request)).status, 200);
  assert.equal((await Fee.findById(fee._id)).status, 'paid');
  assert.equal((await invoke(webhook.handleStripeWebhook, request)).body.duplicate, true);
});
test('Stripe checkout completion without payment does not mark a fee paid', async () => {
  const fee = await Fee.create({ student: sender._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition', amount: 25, recordedBy: sender._id });
  const event = {
    id: 'evt_unpaid', type: 'checkout.session.completed',
    data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', metadata: { kind: 'fee', feeId: fee.id, payerId: sender.id } } }
  };
  const body = JSON.stringify(event);
  const result = await invoke(webhook.handleStripeWebhook, { body: Buffer.from(body), headers: {
    'stripe-signature': getStripeClient().webhooks.generateTestHeaderString({ payload: body, secret: env.stripe.webhookSecret })
  } });
  assert.equal(result.status, 200);
  assert.equal((await Fee.findById(fee._id)).status, 'pending');
});
test('Paddle fee sync and webhook settle concurrently without duplicate effects', async () => {
  const fee = await Fee.create({ student: sender._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition', amount: 25, recordedBy: sender._id });
  const transaction = { id: 'txn_fee_test', status: 'completed', custom_data: { kind: 'fee', feeId: fee.id, payerId: sender.id } };
  const [result] = await Promise.all([
    invoke(webhook.handlePaddleWebhook, paddleRequest(transaction)),
    webhook.handleFeePaddleCompleted(transaction)
  ]);
  assert.equal(result.status, 200);
  const paidFee = await Fee.findById(fee._id);
  assert.equal(paidFee.status, 'paid');
  assert.equal(paidFee.paddleTransactionId, transaction.id);
  assert.equal(await WebhookEvent.countDocuments({}), 1);
});
