const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Never use the developer's database, SMTP account or payment credentials.
process.env.NODE_ENV = 'test';
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.JWT_ACCESS_SECRET = 'reliability-test-access-secret';
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
const institutionCtrl = require('../src/controllers/institution.controller');
const { initSocket } = require('../src/realtime/socket');
const env = require('../src/config/env');

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
  const request = { body: { currency: 'USD', recipientEmail: recipient.email, amount: 80 } };
  const results = await Promise.allSettled([invoke(wallet.transfer, request), invoke(wallet.transfer, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 20);
  assert.equal((await Wallet.findOne({ user: recipient._id })).available, 80);
  assert.equal(await WalletTransaction.countDocuments({}), 2);
});
test('a transfer to an email with no matching account touches zero balance, and a real transfer gets a shared, findable receipt reference on both sides', async () => {
  await assert.rejects(invoke(wallet.transfer, { body: { currency: 'USD', recipientEmail: 'nobody-real@example.test', amount: 30 } }), { statusCode: 404 });
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100, 'sender balance is untouched — nothing was ever deducted');
  assert.equal(await WalletTransaction.countDocuments({}), 0, 'no ledger entry is created for a failed lookup');

  const result = await invoke(wallet.transfer, { body: { currency: 'USD', recipientEmail: recipient.email, amount: 30 } });
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

test('ledger failure rolls back both transfer balances and the first ledger entry', async (t) => {
  const original = WalletTransaction.create.bind(WalletTransaction);
  let writes = 0;
  t.mock.method(WalletTransaction, 'create', (...args) => {
    if (++writes === 2) throw new Error('Injected second ledger failure');
    return original(...args);
  });
  await assert.rejects(invoke(wallet.transfer, { body: { currency: 'USD', recipientEmail: recipient.email, amount: 25 } }), /Injected/);
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
  assert.equal(await Wallet.countDocuments({ user: recipient._id }), 0);
  assert.equal(await WalletTransaction.countDocuments({}), 0);
});
test('invalid monetary input never changes the ledger', async () => {
  for (const amount of ['10', {}, NaN, Infinity, -1, 0]) {
    await assert.rejects(invoke(wallet.transfer, { body: { currency: 'USD', recipientEmail: recipient.email, amount } }), { statusCode: 422 });
  }
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100);
});
test('a withdrawal without the account holder\'s name is rejected, and a valid request gets a findable receipt immediately — before any admin review', async () => {
  await assert.rejects(invoke(wallet.requestWithdrawal, {
    body: { currency: 'USD', amount: 40, payoutMethod: 'bank_transfer', bankName: 'UBL', accountNumber: '0833272270819' }
  }), { statusCode: 422 });
  assert.equal((await Wallet.findOne({ user: sender._id })).available, 100, 'rejected request touches no balance');

  const result = await invoke(wallet.requestWithdrawal, {
    body: { currency: 'USD', amount: 40, payoutMethod: 'bank_transfer', bankName: 'UBL', accountNumber: 'PK78UNIL0109000272270819', accountTitle: 'Sender Full Name' }
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
    body: { currency: 'USD', amount: 40, payoutMethod: 'bank_transfer', bankName: 'UBL', accountNumber: '0833272270819', accountTitle: 'Test Sender' }
  }), /Injected/);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});
test('concurrent withdrawal requests cannot reserve the same funds twice', async () => {
  const request = { body: { currency: 'USD', amount: 80, payoutMethod: 'bank_transfer', bankName: 'UBL', accountNumber: '0833272270819', accountTitle: 'Test Sender' } };
  const results = await Promise.allSettled([invoke(wallet.requestWithdrawal, request), invoke(wallet.requestWithdrawal, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 20);
  assert.equal(balance.pending, 80);
  assert.equal(await WalletTransaction.countDocuments({ type: 'withdrawal' }), 1);
});
test('concurrent withdrawal reviews release reserved funds only once', async () => {
  const result = await invoke(wallet.requestWithdrawal, { body: { currency: 'USD', amount: 40, payoutMethod: 'bank_transfer', bankName: 'UBL', accountNumber: '0833272270819', accountTitle: 'Test Sender' } });
  const request = { body: { decision: 'rejected' }, params: { id: result.body.data.id } };
  const results = await Promise.allSettled([invoke(wallet.reviewWithdrawal, request), invoke(wallet.reviewWithdrawal, request)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const balance = await Wallet.findOne({ user: sender._id });
  assert.equal(balance.available, 100);
  assert.equal(balance.pending, 0);
});

// JazzCash settlement (jazzcash.controller.js applyOutcome) runs in one transaction: a failure
// leaves the checkout and the fee untouched so a later confirmation can settle it.
const jazzcash = require('../src/controllers/jazzcash.controller');
const JazzCashPayment = require('../src/models/JazzCashPayment');
test('a failed JazzCash fee settlement rolls back fully and a later confirmation succeeds once', async (t) => {
  const fee = await Fee.create({ student: sender._id, institution: new mongoose.Types.ObjectId(), title: 'Tuition', amount: 25, currency: 'PKR', recordedBy: sender._id });
  await JazzCashPayment.create({ txnRefNo: 'T_ROLLBACK', kind: 'fee', payer: sender._id, fee: fee._id, amountPaisa: 2500, amount: 25, currency: 'PKR' });
  const failure = t.mock.method(Institution, 'findById', () => { throw new Error('Injected post-save failure'); });
  await assert.rejects(jazzcash.applyOutcome('T_ROLLBACK', { code: '000', rrn: 'RRN1' }), /Injected/);
  assert.equal((await Fee.findById(fee._id)).status, 'pending');
  assert.equal((await JazzCashPayment.findOne({ txnRefNo: 'T_ROLLBACK' })).status, 'pending');
  failure.mock.restore();
  await jazzcash.applyOutcome('T_ROLLBACK', { code: '000', rrn: 'RRN1' });
  await jazzcash.applyOutcome('T_ROLLBACK', { code: '000', rrn: 'RRN1' });
  const paid = await Fee.findById(fee._id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paymentHistory.length, 1);
});
test('return, IPN and sync confirming one JazzCash top-up at once credit the wallet once', async () => {
  const pending = await WalletTransaction.create({ user: sender._id, type: 'topup', amount: 25, currency: 'USD', status: 'pending', reference: 'T_CONCURRENT' });
  await JazzCashPayment.create({ txnRefNo: 'T_CONCURRENT', kind: 'wallet_topup', payer: sender._id, walletTransaction: pending._id, amountPaisa: 700000, amount: 25, currency: 'USD' });
  await Promise.allSettled([1, 2, 3].map(() => jazzcash.applyOutcome('T_CONCURRENT', { code: '000', rrn: 'RRN2' })));
  assert.equal((await Wallet.findOne({ user: sender._id, currency: 'USD' })).available, 125);
  assert.equal((await WalletTransaction.findById(pending._id)).status, 'completed');
});
