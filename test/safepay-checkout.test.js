const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Safepay hosted checkout over real HTTP, with Safepay's own API replaced by a fake that keeps
// trackers in memory: checkout → return (signature + Safepay's tracker state) → settlement.
process.env.NODE_ENV = 'test';
// These tests cover the online checkouts, which are switched off in production for now.
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.SAFEPAY_ENVIRONMENT = 'sandbox';
process.env.SAFEPAY_API_KEY = 'sec_test_key';
process.env.SAFEPAY_SECRET_KEY = 'test_secret_for_safepay';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);

// The fake Safepay: /order/v1/init makes a tracker; /order/v1/:tracker reports it.
const trackers = new Map();
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (!u.startsWith('https://sandbox.api.getsafepay.com')) return realFetch(url, options);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/order/v1/init')) {
    const body = JSON.parse(options.body);
    const token = `track_${crypto.randomUUID()}`;
    trackers.set(token, { token, client: body.client, amount: body.amount, currency: body.currency, state: 'TRACKER_STARTED', transaction: null });
    return json(200, { data: trackers.get(token), status: { errors: [], message: 'success' } });
  }
  const token = decodeURIComponent(u.split('/order/v1/')[1] || '');
  if (options.headers?.['X-SFPY-MERCHANT-SECRET'] !== process.env.SAFEPAY_SECRET_KEY || !trackers.has(token)) return json(404, { status: { errors: ['not found'] } });
  return json(200, { data: trackers.get(token) });
};
const paidOnSafepay = (token, amount) => trackers.set(token, { ...trackers.get(token), ...(amount ? { amount } : {}), state: 'TRACKER_ENDED', transaction: { reference: `SP-${token.slice(-6)}` } });
const sig = (token, secret = process.env.SAFEPAY_SECRET_KEY) => crypto.createHmac('sha256', secret).update(token).digest('hex');

let mongo, server, base, school;
const u = {};
async function account(name, roles) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@safepay.test`, passwordHash: 'x', emailVerified: true, roles: [roles] });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: roles, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role: roles, completed: true, percent: 100 });
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// The payer's browser coming back from Safepay.
const comeBack = (params) => fetch(`${base}/payments/safepay/return?${new URLSearchParams(params)}`, { redirect: 'manual' });
const walletOf = async (who) => (await model('Wallet').findOne({ user: u[who]._id, currency: 'PKR' }))?.available || 0;
const newFee = (amount) => model('Fee').create({ institution: school._id, student: u.Kid._id, recordedBy: u.Owner._id, title: `Fee ${amount}`, amount, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 864e5) });
async function startFee(fee) {
  const r = await api('Kid', 'POST', `/payments/jazzcash/fees/${fee._id}/checkout`, { gateway: 'safepay' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const url = new URL(r.body.data.redirectUrl);
  return { ref: r.body.data.txnRefNo, token: url.searchParams.get('beacon'), url };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution_owner');
  await account('Kid', 'student');
  await account('Stranger', 'student');
  school = await model('Institution').create({ name: 'Safepay School', slug: 'safepay-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  await model('Setting').create({ key: 'institution_fee_commission_percent', value: 10 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { global.fetch = realFetch; await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('config says Safepay is on', async () => {
  const r = await fetch(`${base}/payments/safepay/config`).then((x) => x.json());
  assert.deepEqual([r.data.enabled, r.data.environment], [true, 'sandbox']);
});

test('fee paid with Safepay: checkout page, verified return, institute wallet credited less commission', async () => {
  const fee = await newFee(5000);
  const { ref, token, url } = await startFee(fee);
  assert.equal(url.origin + url.pathname, 'https://sandbox.api.getsafepay.com/checkout/pay');
  assert.equal(url.searchParams.get('order_id'), ref);
  assert.equal(trackers.get(token).amount, 5000, 'Safepay is asked for exactly the fee');
  assert.equal((await model('Fee').findById(fee._id)).status, 'processing');

  // Coming back before paying (or a forged return) credits nothing.
  let res = await comeBack({ order_id: ref, tracker: token, sig: sig(token) });
  assert.match(res.headers.get('location'), /safepay=awaiting_payment/);
  paidOnSafepay(token);
  res = await comeBack({ order_id: ref, tracker: token, sig: sig(token, 'wrong-secret') });
  assert.match(res.headers.get('location'), /safepay=error/, 'bad signature');
  assert.equal(await walletOf('Owner'), 0);

  res = await comeBack({ order_id: ref, tracker: token, sig: sig(token) });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /\/dashboard\?safepay=paid/);
  const paid = await model('Fee').findById(fee._id);
  assert.deepEqual([paid.status, paid.paidVia, paid.escrowStatus], ['paid', 'Safepay', 'released']);
  assert.equal(await walletOf('Owner'), 4500, '5000 less 10% to the institute, nothing held');

  await comeBack({ order_id: ref, tracker: token, sig: sig(token) });
  assert.equal(await walletOf('Owner'), 4500, 'a repeated return credits nothing');
});

test('a tracker paid for a different amount, or someone else\'s tracker, is never applied', async () => {
  const fee = await newFee(3000);
  const { ref, token } = await startFee(fee);
  paidOnSafepay(token, 10);
  const res = await comeBack({ order_id: ref, tracker: token, sig: sig(token) });
  assert.match(res.headers.get('location'), /safepay=error/);
  assert.notEqual((await model('Fee').findById(fee._id)).status, 'paid');

  const other = await startFee(await newFee(3000));
  paidOnSafepay(other.token);
  const swapped = await comeBack({ order_id: ref, tracker: other.token, sig: sig(other.token) });
  assert.match(swapped.headers.get('location'), /safepay=error/, 'tracker of another checkout');
});

test('cancel on Safepay releases the fee so it can be paid again', async () => {
  const fee = await newFee(1200);
  const { ref } = await startFee(fee);
  const res = await fetch(`${base}/payments/safepay/cancel?ref=${ref}`, { redirect: 'manual' });
  assert.match(res.headers.get('location'), /safepay=cancelled/);
  assert.equal((await model('Fee').findById(fee._id)).status, 'pending');
  assert.equal((await model('JazzCashPayment').findOne({ txnRefNo: ref })).status, 'failed');
});

test('sync asks Safepay when the return never arrived; wallet top-up credits once', async () => {
  const r = await api('Kid', 'POST', '/payments/jazzcash/wallet/topup', { amount: 750, currency: 'PKR', gateway: 'safepay' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = new URL(r.body.data.redirectUrl).searchParams.get('beacon');
  assert.equal((await api('Stranger', 'GET', `/payments/safepay/${r.body.data.txnRefNo}/sync`)).status, 404, 'only the payer');
  paidOnSafepay(token);
  const s = await api('Kid', 'GET', `/payments/jazzcash/${r.body.data.txnRefNo}/sync`);
  assert.equal(s.body.data.status, 'paid');
  await api('Kid', 'GET', `/payments/safepay/${r.body.data.txnRefNo}/sync`);
  assert.equal(await walletOf('Kid'), 750);
});
