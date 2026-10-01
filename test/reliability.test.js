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
const Payslip = require('../src/models/Payslip');
const Currency = require('../src/models/Currency');
const wallet = require('../src/controllers/wallet.controller');
const webhook = require('../src/controllers/webhook.controller');
const institutionCtrl = require('../src/controllers/institution.controller');
const payment = require('../src/controllers/payment.controller');
const paddleService = require('../src/services/paddle.service');
const { initSocket } = require('../src/realtime/socket');
const env = require('../src/config/env');
const { getStripeClient } = require('../src/services/stripe.service');

let database, server, io, origin, sender, recipient;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Wallet, WalletTransaction, WebhookEvent, Fee, Institution, Setting, Payslip, Currency].map((model) => model.init()));
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
  await Promise.all([User, Wallet, WalletTransaction, WebhookEvent, Fee, Institution, Setting, Payslip, Currency].map((model) => model.deleteMany({})));
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
// The real flow (payment.controller.js's createWalletTopup) creates this pending ledger entry at
// checkout-creation time, before Paddle is even contacted — the webhook then only ever completes
// it, never fabricates it. Tests that drive the webhook directly must seed the same precondition.
function seedPendingTopup(id = 'txn_topup_test', amount = 25, currency = 'USD') {
  return WalletTransaction.create({ user: sender._id, type: 'topup', amount, currency, status: 'pending', paddleTransactionId: id });
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
test('a transfer to an email with no matching account touches zero balance, and a real transfer gets a shared, findable receipt reference on both sides', async () => {
  await assert.rejects(invoke(wallet.transfer, { body: { recipientEmail: 'nobody-real@example.test', amount: 30 } }), { statusCode: 404 });
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100, 'sender balance is untouched — nothing was ever deducted');
  assert.equal(await WalletTransaction.countDocuments({}), 0, 'no ledger entry is created for a failed lookup');

  const result = await invoke(wallet.transfer, { body: { recipientEmail: recipient.email, amount: 30 } });
  assert.ok(result.body.data.reference, 'a receipt reference is returned to the sender');
  const [outEntry, inEntry] = await Promise.all([
    WalletTransaction.findOne({ user: sender._id, type: 'transfer_out' }),
    WalletTransaction.findOne({ user: recipient._id, type: 'transfer_in' })
  ]);
  assert.equal(outEntry.reference, result.body.data.reference);
  assert.equal(inEntry.reference, result.body.data.reference, 'both legs of the same movement share one findable receipt id');
});
test('paying a payslip via CareerZ Internal Wallet moves real ledger balance atomically and stamps a findable receipt reference on both sides', async () => {
  const institution = await Institution.create({ name: 'Payroll Institution', slug: 'payroll-institution', type: 'school', country: 'PK', owner: sender._id, verificationStatus: 'approved' });
  const payslip = await Payslip.create({ institution: institution._id, staff: recipient._id, month: 9, year: 2026, basicSalary: 40, netAmount: 40, currency: 'USD', status: 'pending', generatedBy: sender._id });

  const res = await invoke(institutionCtrl.markPayslipPaid, { user: sender, params: { payslipId: payslip._id.toString() }, body: { paymentMethod: 'platform_wallet' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'paid');
  assert.ok(res.body.data.transactionId);

  assert.equal((await Wallet.findOne({ user: sender._id, currency: 'USD' })).available, 60, 'institution wallet debited by the exact net amount');
  assert.equal((await Wallet.findOne({ user: recipient._id, currency: 'USD' })).available, 40, 'employee wallet credited by the exact net amount');

  const [outEntry, inEntry] = await Promise.all([
    WalletTransaction.findOne({ user: sender._id, type: 'transfer_out' }),
    WalletTransaction.findOne({ user: recipient._id, type: 'transfer_in' })
  ]);
  assert.equal(outEntry.reference, res.body.data.transactionId);
  assert.equal(inEntry.reference, res.body.data.transactionId, 'both wallet ledger entries share the same findable receipt as the payslip');
});

test('paying a payslip via CareerZ Internal Wallet is refused, with zero balance moved, when the institution wallet is not funded enough', async () => {
  const institution = await Institution.create({ name: 'Payroll Institution 2', slug: 'payroll-institution-2', type: 'school', country: 'PK', owner: sender._id, verificationStatus: 'approved' });
  const payslip = await Payslip.create({ institution: institution._id, staff: recipient._id, month: 9, year: 2026, basicSalary: 500, netAmount: 500, currency: 'USD', status: 'pending', generatedBy: sender._id });
  await assert.rejects(invoke(institutionCtrl.markPayslipPaid, { user: sender, params: { payslipId: payslip._id.toString() }, body: { paymentMethod: 'platform_wallet' } }), { statusCode: 422 });
  assert.equal((await Wallet.findOne({ user: sender._id, currency: 'USD' })).available, 100, 'institution wallet untouched');
  assert.equal(await Wallet.countDocuments({ user: recipient._id }), 0, 'no wallet was ever created/credited for the recipient');
  assert.equal(await WalletTransaction.countDocuments({}), 0);
  const stillPending = await Payslip.findById(payslip._id);
  assert.notEqual(stillPending.status, 'paid');
});

test('a wallet top-up in a Paddle-unsupported currency (PKR) converts to USD for Paddle only — the wallet still credits in PKR', async (t) => {
  await Currency.create({ name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 });
  let capturedCurrency = null, capturedAmount = null;
  t.mock.method(paddleService, 'createTransaction', async ({ amount, currencyCode }) => {
    capturedAmount = amount; capturedCurrency = currencyCode;
    return { id: 'txn_pkr_test', status: 'draft' };
  });

  const res = await invoke(payment.createWalletTopup, { body: { amount: 10000, currency: 'PKR' } });
  assert.equal(res.status, 200, 'the request that used to fail with Paddle\'s generic "invalid request" now succeeds');
  assert.equal(capturedCurrency, 'USD', 'Paddle itself only ever sees a currency it actually supports');
  assert.equal(capturedAmount, Number((10000 * 0.0036).toFixed(2)), 'the USD amount sent to Paddle is correctly converted');

  const pending = await WalletTransaction.findOne({ paddleTransactionId: 'txn_pkr_test' });
  assert.equal(pending.currency, 'PKR', 'the wallet ledger entry still tracks the currency the user actually chose');
  assert.equal(pending.amount, 10000, 'and the original PKR amount, not the converted one');

  // Simulate Paddle confirming that (USD-priced) transaction — the wallet must still credit PKR.
  const transaction = {
    id: 'txn_pkr_test', status: 'completed', currency_code: 'USD',
    custom_data: { kind: 'wallet_topup', userId: sender._id.toString(), currency: 'USD' },
    items: [{ quantity: 1, price: { unit_price: { amount: '3600', currency_code: 'USD' } } }]
  };
  await webhook.handleWalletTopupCompleted(transaction);
  assert.equal((await Wallet.findOne({ user: sender._id, currency: 'PKR' })).available, 10000, 'wallet credited 10000 PKR, not 3600 of anything');
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
test('a withdrawal without the account holder\'s name is rejected, and a valid request gets a findable receipt immediately — before any admin review', async () => {
  await assert.rejects(invoke(wallet.requestWithdrawal, {
    body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'test account' }
  }), { statusCode: 422 });
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100, 'rejected request touches no balance');

  const result = await invoke(wallet.requestWithdrawal, {
    body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'ACC-123', accountTitle: 'Sender Full Name' }
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.data.reference, 'a receipt reference exists on the pending request, before any admin has reviewed it');
  const record = await WalletTransaction.findById(result.body.data.id);
  assert.equal(record.status, 'pending');
  assert.equal(record.reference, result.body.data.reference);
  assert.match(record.payoutDetails, /Sender Full Name/, 'the account holder\'s name is recorded alongside the account number, for Admin review');
});
test('withdrawal ledger failure restores the available and pending balances', async (t) => {
  t.mock.method(WalletTransaction, 'create', () => { throw new Error('Injected withdrawal ledger failure'); });
  await assert.rejects(invoke(wallet.requestWithdrawal, {
    body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'test account', accountTitle: 'Test Sender' }
  }), /Injected/);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});
test('concurrent withdrawal requests cannot reserve the same funds twice', async () => {
  const request = { body: { amount: 80, payoutMethod: 'bank_transfer', payoutDetails: 'test account', accountTitle: 'Test Sender' } };
  const results = await Promise.allSettled([invoke(wallet.requestWithdrawal, request), invoke(wallet.requestWithdrawal, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 20);
  assert.equal(balance.pending, 80);
  assert.equal(await WalletTransaction.countDocuments({ type: 'withdrawal' }), 1);
});
test('concurrent withdrawal reviews release reserved funds only once', async () => {
  const result = await invoke(wallet.requestWithdrawal, { body: { amount: 40, payoutMethod: 'bank_transfer', payoutDetails: 'test account', accountTitle: 'Test Sender' } });
  const request = { body: { decision: 'rejected' }, params: { id: result.body.data.id } };
  const results = await Promise.allSettled([invoke(wallet.reviewWithdrawal, request), invoke(wallet.reviewWithdrawal, request)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});
test('signed duplicate webhooks and concurrent checkout sync credit a top-up once', async () => {
  await seedPendingTopup();
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
  await seedPendingTopup();
  const failure = t.mock.method(Wallet, 'findOneAndUpdate', () => { throw new Error('Injected wallet failure'); });
  const request = paddleRequest(topup());
  const first = await invoke(webhook.handlePaddleWebhook, request);
  assert.equal(first.status, 500);
  assert.equal(await WebhookEvent.countDocuments({}), 0);
  assert.equal(await WalletTransaction.countDocuments({ status: 'completed' }), 0, 'the seeded pending record is rolled back to pending, never left completed');
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
  failure.mock.restore();
  assert.equal((await invoke(webhook.handlePaddleWebhook, request)).status, 200);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 125);
});
test('unpaid, wrong-purpose and currency-mismatched top-ups never credit', async () => {
  await seedPendingTopup();
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

test('a fee in a Paddle-unsupported currency (PKR) converts to USD for Paddle only — the fee still settles in PKR', async (t) => {
  await Currency.create({ name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 });
  const fee = await Fee.create({ student: sender._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition', amount: 10000, currency: 'PKR', recordedBy: sender._id });

  let capturedCurrency = null, capturedAmount = null;
  t.mock.method(paddleService, 'createTransaction', async ({ amount, currencyCode }) => {
    capturedAmount = amount; capturedCurrency = currencyCode;
    return { id: 'txn_fee_pkr_test', status: 'draft' };
  });

  const res = await invoke(payment.createPaddleTransaction, { user: sender, params: { feeId: fee.id }, body: {} });
  assert.equal(res.status, 200, 'the request that used to fail with Paddle\'s generic "invalid request" now succeeds');
  assert.equal(capturedCurrency, 'USD', 'Paddle itself only ever sees a currency it actually supports');
  assert.equal(capturedAmount, Number((10000 * 0.0036).toFixed(2)));

  const transaction = { id: 'txn_fee_pkr_test', status: 'completed', custom_data: { kind: 'fee', feeId: fee.id, payerId: sender.id } };
  await webhook.handleFeePaddleCompleted(transaction);
  const paidFee = await Fee.findById(fee._id);
  assert.equal(paidFee.status, 'paid');
  assert.equal(paidFee.amount, 10000, 'the fee settles for the real PKR amount, not the converted USD figure');
  assert.equal(paidFee.currency, 'PKR');
});

test('a course priced in a Paddle-unsupported currency (PKR) converts to USD for Paddle, verifies against that converted figure, and settles the real PKR purchase', async (t) => {
  await Currency.create({ name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 });
  const Course = require('../src/models/Course');
  const CoursePurchase = require('../src/models/CoursePurchase');
  await Promise.all([Course.init(), CoursePurchase.init()]);
  const course = await Course.create({ title: 'PKR Course', teacher: sender._id, price: 5000, currency: 'PKR', isFree: false, published: true });

  t.mock.method(paddleService, 'createTransaction', async ({ amount, currencyCode }) => ({ id: 'txn_course_pkr_test', status: 'draft', _sent: { amount, currencyCode } }));
  const res = await invoke(payment.createPaddleCourseCheckout, { user: recipient, params: { courseId: course._id.toString() }, body: {} });
  assert.equal(res.status, 200);

  const purchase = await CoursePurchase.findOne({ provider: 'paddle', providerCheckoutId: 'txn_course_pkr_test' });
  assert.equal(purchase.currency, 'PKR', 'the real purchase record keeps the course\'s actual currency');
  assert.equal(purchase.gatewayCurrency, 'USD', 'the Paddle-side currency is tracked separately');

  const expectedUsdMinor = Math.round(Number((5000 * 0.0036).toFixed(2)) * 100);
  const transaction = {
    id: 'txn_course_pkr_test', status: 'completed',
    custom_data: { kind: 'course', courseId: course._id.toString(), studentId: recipient._id.toString() },
    currency_code: 'USD',
    items: [{ quantity: 1, price: { unit_price: { amount: String(expectedUsdMinor), currency_code: 'USD' } } }]
  };
  await webhook.handleCoursePaddleCompleted(transaction);
  const settled = await CoursePurchase.findById(purchase._id);
  assert.equal(settled.status, 'paid');
  assert.equal(settled.currency, 'PKR', 'the settled purchase is still recorded in the real PKR the student was charged');
});
