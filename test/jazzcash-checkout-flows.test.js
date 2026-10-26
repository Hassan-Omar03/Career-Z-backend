const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Featured job, institute plan and tuition fee: all paid through JazzCash. Nothing changes until
// a signed, matching JazzCash confirmation arrives; a failure releases the pending record.
process.env.NODE_ENV = 'test';
// These tests cover the online checkouts, which are switched off in production for now.
process.env.ONLINE_PAYMENTS_ENABLED = 'true';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.JAZZCASH_MERCHANT_ID = 'MC_FLOWS';
process.env.JAZZCASH_PASSWORD = 'flows-password';
process.env.JAZZCASH_INTEGRITY_SALT = 'flows-salt';
process.env.JAZZCASH_RETURN_URL = '';
process.env.JAZZCASH_DEBUG = 'false';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (to, msg) => { sent.push({ to: String(to), title: msg.title }); return {}; });
const model = (n) => require(`../src/models/${n}`);
const jazzCash = require('../src/services/jazzcash.service');
const ctrl = require('../src/controllers/jazzcash.controller');
const subscription = require('../src/controllers/subscription.controller');
const tutoring = require('../src/controllers/teacherStudentLink.controller');

const names = ['User', 'Job', 'FeaturedListing', 'Institution', 'SubscriptionPurchase', 'TeacherStudentLink', 'ParentChildLink', 'Course', 'Currency', 'JazzCashPayment'];
let database, owner, parent, kid, tutor;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  for (const n of names) await model(n).init();
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const n of names) await model(n).deleteMany({});
  sent.length = 0;
  [owner, parent, kid, tutor] = await model('User').create([
    { fullName: 'Owner', email: 'owner@flows.test', passwordHash: 'x', roles: ['institution_owner', 'employer'] },
    { fullName: 'Mum', email: 'mum@flows.test', passwordHash: 'x', roles: ['parent'] },
    { fullName: 'Kid', email: 'kid@flows.test', passwordHash: 'x', roles: ['student'] },
    { fullName: 'Tutor', email: 'tutor@flows.test', passwordHash: 'x', roles: ['teacher'] }
  ]);
  await model('Currency').create([
    { name: 'US Dollar', code: 'USD', symbol: '$', exchangeRateToUSD: 1 },
    { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', exchangeRateToUSD: 0.0036 }
  ]);
});
function invoke(handler, { params = {}, user = owner, body = {}, headers = {} } = {}) {
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
    pp_Amount: checkout.fields.pp_Amount, pp_MerchantID: 'MC_FLOWS', pp_ResponseCode: '000', pp_ResponseMessage: 'Success',
    pp_RetreivalReferenceNo: `RRN${checkout.txnRefNo.slice(-6)}`, pp_TxnCurrency: 'PKR', pp_TxnRefNo: checkout.txnRefNo, pp_Version: '1.1', ...overrides
  };
  fields.pp_SecureHash = jazzCash.secureHash(fields);
  return fields;
}
const pkrPaisa = (usd) => String(Math.round((usd / 0.0036) * 100));
const browserReturn = (body) => invoke(ctrl.handleReturn, { body, user: undefined });

test('featured job: USD 20 is charged in PKR; the job is featured only after confirmation, once', async () => {
  const job = await model('Job').create({ postedBy: owner._id, title: 'Physics Teacher', company: 'Pay School', country: 'PK', status: 'active' });
  const checkout = (await invoke(ctrl.createFeaturedJobCheckout, { params: { jobId: job.id } })).body.data;
  assert.equal(checkout.fields.pp_Amount, pkrPaisa(20));
  const listing = await model('FeaturedListing').findOne({ job: job._id });
  assert.deepEqual([listing.status, listing.paymentMethod], ['pending', 'jazzcash']);
  assert.equal((await model('Job').findById(job._id)).featured, false, 'not featured before payment');

  const body = signedReturn(checkout);
  const result = await browserReturn(body);
  assert.match(result.redirect, /jazzcash=paid/);
  await invoke(ctrl.handleIpn, { body });
  const featured = await model('Job').findById(job._id);
  assert.equal(featured.featured, true);
  assert.equal(String(featured.featuredUntil), String(listing.expiresAt));
  assert.equal((await model('FeaturedListing').findById(listing._id)).status, 'paid');
  assert.equal(sent.filter((n) => /Job featured/.test(n.title)).length, 1, 'one confirmation despite return + IPN');
});

test('featured job: a failed JazzCash payment marks the listing failed and never features the job', async () => {
  const job = await model('Job').create({ postedBy: owner._id, title: 'Driver', company: 'Pay School', country: 'PK', status: 'active' });
  const checkout = (await invoke(ctrl.createFeaturedJobCheckout, { params: { jobId: job.id } })).body.data;
  await browserReturn(signedReturn(checkout, { pp_ResponseCode: '999' }));
  assert.equal((await model('FeaturedListing').findOne({ job: job._id })).status, 'failed');
  assert.equal((await model('Job').findById(job._id)).featured, false);
});

test('institute plan: only the owner can buy; 30 days start only after confirmation; renewing stacks', async () => {
  const school = await model('Institution').create({ name: 'Plan School', slug: 'plan-school', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  await assert.rejects(invoke(subscription.createSubscriptionCheckout, { params: { id: school.id }, body: { plan: 'basic' }, user: parent }), { statusCode: 403 });
  await assert.rejects(invoke(subscription.createSubscriptionCheckout, { params: { id: school.id }, body: { plan: 'free' } }), { statusCode: 422 });

  const first = (await invoke(subscription.createSubscriptionCheckout, { params: { id: school.id }, body: { plan: 'basic' } })).body.data;
  assert.equal(first.fields.pp_Amount, pkrPaisa(29), 'Basic plan USD 29 in PKR');
  assert.notEqual((await model('Institution').findById(school._id)).subscription?.plan, 'basic', 'still on the free plan before payment');
  await browserReturn(signedReturn(first));
  let fresh = await model('Institution').findById(school._id);
  assert.deepEqual([fresh.subscription.plan, fresh.subscription.status], ['basic', 'active']);
  const firstEnd = fresh.subscription.currentPeriodEnd.getTime();
  assert.ok(Math.abs(firstEnd - Date.now() - 30 * 864e5) < 60000, 'active for 30 days');

  // Renewing the same plan by paying again adds 30 days to the current period.
  const second = (await invoke(subscription.createSubscriptionCheckout, { params: { id: school.id }, body: { plan: 'basic' } })).body.data;
  await browserReturn(signedReturn(second));
  await browserReturn(signedReturn(second));
  fresh = await model('Institution').findById(school._id);
  assert.equal(fresh.subscription.currentPeriodEnd.getTime(), firstEnd + 30 * 864e5);
  assert.equal(await model('SubscriptionPurchase').countDocuments({ status: 'paid', paymentMethod: 'jazzcash' }), 2);
});

test('institute plan: a failed payment marks the purchase failed and leaves the plan unchanged', async () => {
  const school = await model('Institution').create({ name: 'Fail School', slug: 'fail-school', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  const checkout = (await invoke(subscription.createSubscriptionCheckout, { params: { id: school.id }, body: { plan: 'professional' } })).body.data;
  await browserReturn(signedReturn(checkout, { pp_ResponseCode: '124' })); // voucher issued, still waiting
  assert.equal((await model('SubscriptionPurchase').findOne({})).status, 'pending');
  await browserReturn(signedReturn(checkout, { pp_ResponseCode: '999' }));
  assert.equal((await model('SubscriptionPurchase').findOne({})).status, 'failed');
  assert.notEqual((await model('Institution').findById(school._id)).subscription?.plan, 'professional');
});

test('tuition fee: a parent pays in PKR; tutor and family are told who paid; a second payment is kept for refund', async () => {
  const course = await model('Course').create({ title: 'Maths tuition', teacher: tutor._id });
  await model('ParentChildLink').create({ parent: parent._id, student: kid._id, status: 'approved', relationship: 'mother', requestedBy: parent._id });
  const link = await model('TeacherStudentLink').create({ teacher: tutor._id, student: kid._id, course: course._id, status: 'active', feeAmount: 3000, feeCurrency: 'PKR' });
  await assert.rejects(invoke(tutoring.createFeeCheckout, { params: { id: link.id }, user: owner }), { statusCode: 403 });

  const mum = (await invoke(tutoring.createFeeCheckout, { params: { id: link.id }, user: parent })).body.data;
  const kidCheckout = (await invoke(tutoring.createFeeCheckout, { params: { id: link.id }, user: kid })).body.data;
  assert.equal(mum.fields.pp_Amount, '300000', 'PKR 3000 is charged as-is');
  await browserReturn(signedReturn(mum));
  let fresh = await model('TeacherStudentLink').findById(link._id);
  assert.equal(String(fresh.feePaidBy), String(parent._id));
  assert.ok(sent.some((n) => n.to === String(tutor._id) && /Fee paid/.test(n.title)), 'tutor told');

  await browserReturn(signedReturn(kidCheckout));
  fresh = await model('TeacherStudentLink').findById(link._id);
  assert.equal(fresh.extraPayments.length, 1, 'the second payment is recorded, not lost');
  assert.ok(sent.some((n) => n.to === String(tutor._id) && /please refund/.test(n.title)));
  await assert.rejects(invoke(tutoring.createFeeCheckout, { params: { id: link.id }, user: kid }), { statusCode: 400 }, 'a paid fee cannot be opened again');
});

test('a missing PKR exchange rate stops checkout before any pending record is created', async () => {
  await model('Currency').deleteMany({ code: 'PKR' });
  const job = await model('Job').create({ postedBy: owner._id, title: 'Clerk', company: 'Pay School', country: 'PK', status: 'active' });
  await assert.rejects(invoke(ctrl.createFeaturedJobCheckout, { params: { jobId: job.id } }), { statusCode: 422 });
  assert.equal(await model('FeaturedListing').countDocuments({}), 0);
  assert.equal(await model('JazzCashPayment').countDocuments({}), 0);
});
