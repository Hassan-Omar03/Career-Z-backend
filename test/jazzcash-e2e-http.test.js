const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// End to end over real HTTP: every JazzCash checkout the frontend opens, then JazzCash's hosted
// page posting the signed result back as a form (exactly what the browser does), then the
// app's state. Also checks that the removed Paddle/Stripe endpoints are gone.
process.env.NODE_ENV = 'test';
// These tests cover the online checkouts, which are switched off in production for now.
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.JAZZCASH_MERCHANT_ID = 'MC_E2E';
process.env.JAZZCASH_PASSWORD = 'e2e-password';
process.env.JAZZCASH_INTEGRITY_SALT = 'e2e-salt';
process.env.JAZZCASH_RETURN_URL = '';
process.env.JAZZCASH_DEBUG = 'false';
process.env.CLIENT_URL = 'http://localhost:5173';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const jazzCash = require('../src/services/jazzcash.service');
const model = (n) => require(`../src/models/${n}`);

let mongo, server, base;
const u = {};
async function account(name, role) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@e2e.test`, passwordHash: 'x', emailVerified: true, roles: [role] });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// What JazzCash's page posts to pp_ReturnURL: a signed x-www-form-urlencoded form.
async function jazzCashPostsBack(checkout, code = '000') {
  const fields = {
    pp_Amount: checkout.fields.pp_Amount, pp_BillReference: checkout.fields.pp_BillReference, pp_Language: 'EN',
    pp_MerchantID: checkout.fields.pp_MerchantID, pp_ResponseCode: code, pp_ResponseMessage: code === '000' ? 'Thank you for Using JazzCash, your transaction was successful.' : 'Failed',
    pp_RetreivalReferenceNo: code === '000' ? `R${checkout.txnRefNo.slice(-10)}` : '', pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: checkout.fields.pp_TxnDateTime, pp_TxnRefNo: checkout.txnRefNo, pp_TxnType: 'MWALLET', pp_Version: '1.1'
  };
  fields.pp_SecureHash = jazzCash.secureHash(fields);
  const res = await fetch(checkout.fields.pp_ReturnURL, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { status: res.status, location: res.headers.get('location') };
}
function assertSignedForm(checkout, amountPaisa) {
  assert.match(checkout.actionUrl, /^https:\/\/sandbox\.jazzcash\.com\.pk\/CustomerPortal\/transactionmanagement\/merchantform\/$/);
  assert.equal(checkout.fields.pp_Amount, String(amountPaisa));
  assert.equal(checkout.fields.pp_TxnCurrency, 'PKR');
  assert.equal(checkout.fields.pp_ReturnURL, `${base}/payments/jazzcash/return`);
  assert.ok(jazzCash.verifySecureHash(checkout.fields), 'form is signed with the integrity salt');
}
const paisa = (usd) => Math.round((usd / 0.0036) * 100);

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const n of ['User', 'Fee', 'Course', 'Enrollment', 'CoursePurchase', 'Job', 'FeaturedListing', 'Institution', 'SubscriptionPurchase', 'TeacherStudentLink', 'Wallet', 'WalletTransaction', 'JazzCashPayment', 'Currency']) await model(n).init();
  await model('Currency').create([{ name: 'US Dollar', code: 'USD', symbol: '$', exchangeRateToUSD: 1 }, { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 }]);
  await account('Student', 'student');
  await account('Owner', 'institution_owner');
  await account('Employer', 'employer');
  await account('Tutor', 'teacher');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('Paddle and Stripe checkout endpoints are gone; JazzCash and crypto config remain', async () => {
  for (const path of ['/payments/paddle/config', '/payments/stripe/config']) assert.equal((await api('Student', 'GET', path)).status, 404, path);
  // The old webhook receivers no longer exist (they answered 400 "signature failed" or 503).
  for (const path of ['/webhooks/paddle', '/webhooks/stripe']) assert.ok([401, 404].includes((await fetch(base + path, { method: 'POST' })).status), path);
  assert.equal((await api('Student', 'POST', '/payments/paddle/wallet/topup', { amount: 10, currency: 'USD' })).status, 404);
  const jc = await (await fetch(`${base}/payments/jazzcash/config`)).json();
  assert.equal(jc.data.enabled, true);
  assert.equal((await fetch(`${base}/payments/nowpayments/config`)).status, 200);
});

test('institute fee: checkout → JazzCash posts back → fee paid with a receipt, payer returned to the dashboard', async () => {
  const school = await model('Institution').create({ name: 'E2E School', slug: 'e2e-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  const fee = await model('Fee').create({ institution: school._id, student: u.Student._id, recordedBy: u.Owner._id, title: 'October fee', amount: 4500, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 864e5) });
  const res = await api('Student', 'POST', `/payments/jazzcash/fees/${fee._id}/checkout`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSignedForm(res.body.data, 450000);
  const back = await jazzCashPostsBack(res.body.data);
  assert.equal(back.status, 303);
  assert.equal(back.location, `http://localhost:5173/dashboard?jazzcash=paid&ref=${res.body.data.txnRefNo}`);
  const paid = await model('Fee').findById(fee._id);
  assert.deepEqual([paid.status, paid.paymentMethod, Boolean(paid.receiptNumber)], ['paid', 'jazzcash', true]);
});

test('course: USD course charged in PKR, enrolled after JazzCash confirms', async () => {
  const course = await model('Course').create({ title: 'E2E Course', teacher: u.Tutor._id, published: true, isFree: false, price: 10, currency: 'USD' });
  const res = await api('Student', 'POST', `/payments/jazzcash/courses/${course._id}/checkout`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSignedForm(res.body.data, paisa(10));
  assert.match((await jazzCashPostsBack(res.body.data)).location, /jazzcash=paid/);
  assert.ok(await model('Enrollment').exists({ student: u.Student._id, course: course._id }));
});

test('wallet top-up: a failed payment never credits; a successful one credits once', async () => {
  const failed = (await api('Student', 'POST', '/payments/jazzcash/wallet/topup', { amount: 500, currency: 'PKR' })).body.data;
  assert.match((await jazzCashPostsBack(failed, '999')).location, /jazzcash=failed/);
  const ok = (await api('Student', 'POST', '/payments/jazzcash/wallet/topup', { amount: 500, currency: 'PKR' })).body.data;
  assertSignedForm(ok, 50000);
  await jazzCashPostsBack(ok);
  await jazzCashPostsBack(ok); // browser refresh / replay
  const wallet = (await api('Student', 'GET', '/wallet/me?currency=PKR')).body.data;
  assert.equal(wallet.available, 500);
});

test('featured job: employer pays USD 20 in PKR and the job is featured', async () => {
  const job = await model('Job').create({ postedBy: u.Employer._id, title: 'E2E Job', company: 'E2E Co', country: 'PK', status: 'active' });
  const res = await api('Employer', 'POST', `/payments/jazzcash/jobs/${job._id}/feature-checkout`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSignedForm(res.body.data, paisa(20));
  await jazzCashPostsBack(res.body.data);
  assert.equal((await model('Job').findById(job._id)).featured, true);
});

test('institute plan: owner pays the Basic plan (USD 29) and it is active for 30 days', async () => {
  const school = await model('Institution').create({ name: 'Plan E2E', slug: 'plan-e2e', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  const res = await api('Owner', 'POST', `/subscriptions/institutions/${school._id}/checkout`, { plan: 'basic' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSignedForm(res.body.data, paisa(29));
  await jazzCashPostsBack(res.body.data);
  const view = (await api('Owner', 'GET', `/subscriptions/institutions/${school._id}`)).body.data;
  assert.equal(view.activePlan, 'basic');
  assert.ok(new Date(view.subscription.currentPeriodEnd) > new Date(Date.now() + 29 * 864e5));
});

test('tuition fee: student pays the tutor fee through JazzCash', async () => {
  const course = await model('Course').create({ title: 'Tuition E2E', teacher: u.Tutor._id });
  const link = await model('TeacherStudentLink').create({ teacher: u.Tutor._id, student: u.Student._id, course: course._id, status: 'active', feeAmount: 2000, feeCurrency: 'PKR' });
  const res = await api('Student', 'POST', `/teacher-students/${link._id}/fee-checkout`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSignedForm(res.body.data, 200000);
  await jazzCashPostsBack(res.body.data);
  assert.ok((await model('TeacherStudentLink').findById(link._id)).feePaidAt);
});
