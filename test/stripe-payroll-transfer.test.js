const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const stripeService = require('../src/services/stripe.service');

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const TeacherProfile = require('../src/models/TeacherProfile');
const Payslip = require('../src/models/Payslip');
const institutionCtrl = require('../src/controllers/institution.controller');
const teacherCtrl = require('../src/controllers/teacher.controller');

let mongo, owner, teacher, institution, payslip;
const models = [User, Institution, TeacherProfile, Payslip];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  owner = await User.create({ fullName: 'Payroll Owner', email: 'sp-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  teacher = await User.create({ fullName: 'Payroll Teacher', email: 'sp-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  institution = await Institution.create({ name: 'SP Institution', slug: 'sp-institution', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  payslip = await Payslip.create({ institution: institution._id, staff: teacher._id, month: 1, year: 2026, basicSalary: 1000, netAmount: 1000, currency: 'USD', generatedBy: owner._id });
});

test('a real Stripe transfer is refused when Stripe is not configured', async () => {
  mock.method(stripeService, 'isStripeConfigured', () => false);
  const res = await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { id: institution._id.toString(), payslipId: payslip._id.toString() }, body: { paymentMethod: 'stripe_transfer' } });
  assert.equal(res.status, 503);
  mock.reset();
  mock.method(notifications, 'notify', async () => {});
});

test('a real Stripe transfer is refused until the teacher has a connected, payouts-enabled account', async () => {
  mock.method(stripeService, 'isStripeConfigured', () => true);
  const res = await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { id: institution._id.toString(), payslipId: payslip._id.toString() }, body: { paymentMethod: 'stripe_transfer' } });
  assert.equal(res.status, 422);
  mock.reset();
  mock.method(notifications, 'notify', async () => {});
});

test('a real Stripe transfer succeeds once the teacher is connected, and records the transfer id', async () => {
  await TeacherProfile.create({ user: teacher._id, payout: { stripeAccountId: 'acct_test123', payoutsEnabled: true, detailsSubmitted: true } });
  mock.method(stripeService, 'isStripeConfigured', () => true);
  mock.method(stripeService, 'getStripeClient', () => ({
    transfers: { create: async ({ amount, currency, destination }) => { assert.equal(amount, 100000); assert.equal(currency, 'usd'); assert.equal(destination, 'acct_test123'); return { id: 'tr_test123' }; } }
  }));

  const res = await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { id: institution._id.toString(), payslipId: payslip._id.toString() }, body: { paymentMethod: 'stripe_transfer' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'paid');
  assert.equal(res.body.data.stripeTransferId, 'tr_test123');
  assert.equal(res.body.data.transactionId, 'tr_test123');
  mock.reset();
  mock.method(notifications, 'notify', async () => {});
});

test('a failed Stripe transfer never marks the payslip paid, and records the failure', async () => {
  await TeacherProfile.create({ user: teacher._id, payout: { stripeAccountId: 'acct_test456', payoutsEnabled: true, detailsSubmitted: true } });
  mock.method(stripeService, 'isStripeConfigured', () => true);
  mock.method(stripeService, 'getStripeClient', () => ({
    transfers: { create: async () => { throw new Error('insufficient_capabilities'); } }
  }));

  const res = await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { id: institution._id.toString(), payslipId: payslip._id.toString() }, body: { paymentMethod: 'stripe_transfer' } });
  assert.equal(res.status, 422);
  const stored = await Payslip.findById(payslip._id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.stripeTransferStatus, 'failed');
  mock.reset();
  mock.method(notifications, 'notify', async () => {});
});

test('a manual salary report stays processing until the receiving teacher confirms it', async () => {
  const report = await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { payslipId: payslip._id.toString() }, body: { paymentMethod: 'bank_transfer', reference: 'SAL-BANK-001', provider: 'Test Bank', proofUrl: 'https://example.test/salary-proof.pdf' } });
  assert.equal(report.status, 200);
  assert.equal(report.body.data.status, 'processing');
  assert.equal(report.body.data.paidAt, undefined);

  const verify = await invoke(teacherCtrl.verifyMyPayslipPayment, { user: teacher, params: { id: payslip._id.toString() }, body: { decision: 'verify' } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.status, 'paid');
  assert.equal(verify.body.data.transactionId, 'SAL-BANK-001');
});

test('teacher rejection returns a manual salary report to pending without marking it paid', async () => {
  await invoke(institutionCtrl.markPayslipPaid, { user: owner, params: { payslipId: payslip._id.toString() }, body: { paymentMethod: 'cash', reference: 'CASH-001' } });
  const reject = await invoke(teacherCtrl.verifyMyPayslipPayment, { user: teacher, params: { id: payslip._id.toString() }, body: { decision: 'reject', rejectionReason: 'Cash not received' } });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.data.status, 'pending');
  assert.equal(reject.body.data.paidAt, undefined);
});
