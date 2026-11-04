const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
const Setting = require('../src/models/Setting');
const Receipt = require('../src/models/Receipt');
const CommissionRule = require('../src/models/CommissionRule');
const Counter = require('../src/models/Counter');
const { commissionRate, computeReceiptAmounts } = require('../src/utils/receiptCalc');
const rules = require('../src/services/commissionRules.service');
const receipts = require('../src/services/receipt.service');

let mongo; const admin = { _id: new mongoose.Types.ObjectId() }; const id = () => new mongoose.Types.ObjectId();
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri()); await Promise.all([Receipt.init(), CommissionRule.init()]); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await Promise.all([Setting.deleteMany({}), Receipt.deleteMany({}), CommissionRule.deleteMany({}), Counter.deleteMany({})]); });

test('with no rule the plain service rate still applies; the most specific rule wins', async () => {
  await Setting.create({ key: 'course_commission_percent', value: 10 });
  assert.equal(await commissionRate('course_commission_percent'), 10);
  const school = String(id());
  await rules.create(admin, { scope: 'global', serviceType: 'course', percentage: 12 });
  await rules.create(admin, { scope: 'country', scopeValue: 'pk', serviceType: 'course', percentage: 8 });
  await rules.create(admin, { scope: 'institution', scopeValue: school, serviceType: 'course', percentage: 5 });
  assert.equal(await commissionRate('course_commission_percent'), 12);
  assert.equal(await commissionRate('course_commission_percent', null, { country: 'PK' }), 8);
  assert.equal(await commissionRate('course_commission_percent', null, { country: 'PK', institution: school }), 5);
  assert.equal(await commissionRate('donation_commission_percent'), 0, 'another service is untouched');
});

test('dates, a fixed fee and disabling control a rule; clashes are refused; history is kept', async () => {
  await Setting.create({ key: 'marketplace_commission_percent', value: 3 });
  const past = await rules.create(admin, { scope: 'global', serviceType: 'marketplace', percentage: 50, effectiveUntil: new Date(Date.now() - 864e5) });
  assert.equal(await commissionRate('marketplace_commission_percent'), 3, 'an expired rule is ignored');
  const r = await rules.create(admin, { scope: 'category', scopeValue: 'books', serviceType: 'marketplace', percentage: 5, fixedFee: 10 });
  assert.equal(await commissionRate('marketplace_commission_percent:books', null, { category: 'books', amount: 100 }), 15);
  await assert.rejects(rules.create(admin, { scope: 'category', scopeValue: 'books', serviceType: 'marketplace', percentage: 7 }), /already covers/);
  await assert.rejects(rules.create(admin, { scope: 'institution', scopeValue: 'nope', serviceType: 'marketplace', percentage: 7 }), /valid institution/);
  await assert.rejects(rules.create(admin, { scope: 'global', serviceType: 'marketplace', percentage: 170 }), /0 to 100/);
  await rules.update(admin, r._id, { percentage: 6 });
  await rules.setStatus(admin, r._id, 'inactive');
  assert.equal(await commissionRate('marketplace_commission_percent', null, { category: 'books', amount: 100 }), 3);
  const saved = await CommissionRule.findById(r._id).lean();
  assert.deepEqual(saved.history.map((h) => h.action), ['created', 'updated', 'disabled']);
  assert.equal(saved.history[1].before.percentage, 5);
  assert.equal(saved.history[1].after.percentage, 6);
  assert.ok(past);
});

test('receipts are numbered in order, issued once and cannot be changed', async () => {
  const tx = id();
  const a = await receipts.issue({ transactionType: 'ManualPayment', transaction: tx, grossAmount: 110, currency: 'PKR', platformCommission: 10, netAmount: 100 });
  const again = await receipts.issue({ transactionType: 'ManualPayment', transaction: tx, grossAmount: 999, currency: 'PKR' });
  assert.equal(String(again._id), String(a._id));
  const b = await receipts.issue({ transactionType: 'ManualPayment', transaction: id(), grossAmount: 50, currency: 'PKR' });
  const year = new Date().getFullYear();
  assert.equal(a.receiptNumber, `RCP-${year}-000001`);
  assert.equal(b.receiptNumber, `RCP-${year}-000002`);
  await assert.rejects(Receipt.updateOne({ _id: a._id }, { grossAmount: 1 }), /cannot be changed/);
  a.grossAmount = 1;
  await assert.rejects(a.save(), /cannot be changed/);
  assert.equal((await receipts.verify(a.receiptNumber.toLowerCase())).grossAmount, 110);
  await assert.rejects(receipts.verify('RCP-1'), /No receipt/);
});

test('tax and gateway charges come from settings and never change what the seller receives', async () => {
  await Setting.create([{ key: 'course_commission_percent', value: 10 }, { key: 'receipt_tax_percent', value: 16 }, { key: 'receipt_gateway_fee_percent', value: 2 }]);
  const amounts = await computeReceiptAmounts(1000, 'course_commission_percent');
  assert.deepEqual(amounts, { grossAmount: 1000, platformCommission: 100, gatewayCharges: 20, taxAmount: 16, netAmount: 900 });
  const bank = await receipts.issue({ transactionType: 'ManualPayment', transaction: id(), grossAmount: 1000, currency: 'PKR', platformCommission: 100, netAmount: 900 });
  assert.equal(bank.taxAmount, 16);
  assert.equal(bank.gatewayFee, 0, 'a bank transfer has no gateway');
  assert.equal(bank.netAmount, 900);
  await assert.rejects(receipts.setChargesConfig({ taxPercent: 200 }), /0 to 100/);
});
