const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Every manual (proof-based / self-reported) payment flow over real HTTP, with its rules:
// who may report, who may confirm, validation, state changes, and double-submits.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.JAZZCASH_MERCHANT_ID = 'MC_MANUAL';
process.env.JAZZCASH_PASSWORD = 'manual-password';
process.env.JAZZCASH_INTEGRITY_SALT = 'manual-salt';
process.env.JAZZCASH_DEBUG = 'false';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
const oid = () => new mongoose.Types.ObjectId();

let mongo, server, base, school;
const u = {};
async function account(name, roles) {
  roles = [].concat(roles);
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@manual.test`, passwordHash: 'x', emailVerified: true, roles });
  for (const role of roles) {
    await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
    await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
  }
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const say = (r) => JSON.stringify(r.body).slice(0, 240);
const is = (r, code, msg) => assert.equal(r.status, code, `${msg} → ${r.status} ${say(r)}`);
const newFee = (amount = 1000, extra = {}) => model('Fee').create({ institution: school._id, student: u.Kid._id, recordedBy: u.Owner._id, title: `Fee ${amount}`, amount, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 5 * 864e5), ...extra });
const bankReport = (amount, ref = 'BANK-1') => ({ amount, method: 'bank_transfer', reference: ref, bankName: 'HBL', proofUrl: 'https://files.test/proof.jpg' });
const walletOf = async (who, currency = 'PKR') => (await model('Wallet').findOne({ user: u[who]._id, currency }))?.available || 0;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const n of ['Fee', 'Wallet', 'WalletTransaction', 'RecruitmentInvoice', 'Commission', 'Withdrawal', 'Donation', 'FundingRequest', 'Order', 'Product', 'SellerWithdrawal', 'Payslip', 'JazzCashPayment', 'ParentChildLink']) await model(n).init();
  await account('CareerZ', 'super_admin');
  await account('FinanceStaff', 'platform_staff');
  await account('SupportStaff', 'platform_staff');
  await model('StaffProfile').create({ user: u.FinanceStaff._id, departments: ['finance'], active: true, addedBy: u.CareerZ._id });
  await model('StaffProfile').create({ user: u.SupportStaff._id, departments: ['support'], active: true, addedBy: u.CareerZ._id });
  await account('Owner', 'institution_owner');
  await account('Stranger', 'student');
  await account('Kid', 'student');
  await account('Mum', 'parent');
  await account('Dad', 'parent');
  await account('Tutor', 'teacher');
  await account('Agent', 'education_agent');
  await account('Donor', 'donor');
  await account('SelfDonor', ['student', 'donor']);
  await account('Seller', 'marketplace_seller');
  await account('Buyer', 'student');
  school = await model('Institution').create({ name: 'Manual School', slug: 'manual-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  await model('ParentChildLink').create({ parent: u.Mum._id, student: u.Kid._id, status: 'approved', relationship: 'mother', requestedBy: u.Mum._id });
  await model('ParentChildLink').create({ parent: u.Dad._id, student: u.Kid._id, status: 'approved', relationship: 'father', requestedBy: u.Dad._id, permissions: { payFees: false } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

// ───────────────────────────── 1. Fee paid by bank / mobile wallet / cash (student or parent reports)
// ───────────────────────────── 2. Fee paid in cash at the institute counter
// ───────────────────────────── 3. Releasing held fee money
test('fee release: only CareerZ finance can release a paid, held fee, once', async () => {
  const unpaid = await newFee(300);
  const paid = await newFee(300, { status: 'paid', paidAmount: 300, outstandingAmount: 0, escrowStatus: 'held', paidAt: new Date() });
  is(await api('Owner', 'PATCH', `/institutions/fees/${paid._id}/release`), 403, 'institute owner (the UI shows them this button)');
  is(await api('CareerZ', 'PATCH', `/institutions/fees/${unpaid._id}/release`), 400, 'unpaid fee');
  is(await api('CareerZ', 'PATCH', `/institutions/fees/${paid._id}/release`), 200, 'release');
  is(await api('CareerZ', 'PATCH', `/institutions/fees/${paid._id}/release`), 400, 'second release');
});

// ───────────────────────────── 3b. Gateway fee money reaches the institute's wallet
test('gateway fee: commission to CareerZ, the rest straight to the institute wallet, never twice', async () => {
  await model('Wallet').deleteMany({});
  await model('Setting').deleteMany({ key: { $in: ['institution_fee_commission_percent', 'fee_commission_percent'] } });
  await model('Setting').create({ key: 'institution_fee_commission_percent', value: 10 });
  const { settleOnlineFee } = require('../src/controllers/webhook.controller');
  const fee = await newFee(1000);
  const pay = (amount, txn) => mongoose.connection.transaction(async (session) => {
    const f = await model('Fee').findById(fee._id).session(session);
    await settleOnlineFee(f, { amount, method: 'jazzcash', paidVia: 'JazzCash', transactionId: txn, payerId: u.Kid._id }, 'JazzCash', session);
  });
  await pay(400, 'JC-PART-1');
  assert.equal(await walletOf('Owner'), 360, 'instalment: 400 less 10%');
  await pay(600, 'JC-PART-2');
  const paid = await model('Fee').findById(fee._id);
  assert.deepEqual([paid.status, paid.escrowStatus, await walletOf('Owner')], ['paid', 'released', 900], 'paid, nothing held, 900 to the institute');
  assert.equal((await model('FamilyPlatformBalance').findOne({ currency: 'PKR' })).available, 100, 'CareerZ keeps 100');
  await pay(600, 'JC-PART-2-RETRY');
  assert.equal(await walletOf('Owner'), 900, 'a duplicate payment is refunded, not credited');
  await model('Setting').deleteMany({ key: 'institution_fee_commission_percent' });
});

test('fee release: an older held gateway fee pays the institute wallet; a cash fee adds nothing', async () => {
  await model('Wallet').deleteMany({});
  const entry = (method, extra = {}) => ({ amount: 500, method, transactionId: `OLD-${method}-${Date.now()}`, verificationStatus: 'verified', verifiedAt: new Date(), ...extra });
  const gateway = await newFee(500, { status: 'paid', paidAmount: 500, outstandingAmount: 0, escrowStatus: 'held', paidAt: new Date(), paymentHistory: [entry('jazzcash')] });
  const cash = await newFee(500, { status: 'paid', paidAmount: 500, outstandingAmount: 0, escrowStatus: 'held', paidAt: new Date(), paymentHistory: [entry('cash', { proofUrl: 'https://files.test/r.jpg' })] });
  is(await api('CareerZ', 'PATCH', `/institutions/fees/${gateway._id}/release`), 200, 'release gateway fee');
  assert.equal(await walletOf('Owner'), 500, 'credited (no commission set)');
  is(await api('CareerZ', 'PATCH', `/institutions/fees/${cash._id}/release`), 200, 'release cash fee');
  assert.equal(await walletOf('Owner'), 500, 'cash was paid to the institute directly');
});

// ───────────────────────────── 4. Fee refunds
test('fee refund: request and decide follow the rules', async () => {
  const unpaid = await newFee(400);
  const paid = await newFee(400, { status: 'paid', paidAmount: 400, outstandingAmount: 0, paidAt: new Date() });
  is(await api('Kid', 'POST', `/institutions/fees/${unpaid._id}/refund/request`, { reason: 'x' }), 400, 'unpaid fee');
  is(await api('Stranger', 'POST', `/institutions/fees/${paid._id}/refund/request`, { reason: 'x' }), 403, 'unrelated user');
  is(await api('Kid', 'POST', `/institutions/fees/${paid._id}/refund/request`, { reason: 'Left the school' }), 200, 'student requests');
  is(await api('Kid', 'PATCH', `/institutions/fees/${paid._id}/refund/decide`, { decision: 'refunded' }), 403, 'student cannot decide');
  is(await api('Owner', 'PATCH', `/institutions/fees/${paid._id}/refund/decide`, { decision: 'maybe' }), 422, 'bad decision');
  is(await api('Owner', 'PATCH', `/institutions/fees/${paid._id}/refund/decide`, { decision: 'approved' }), 200, 'approve');
  is(await api('Owner', 'PATCH', `/institutions/fees/${paid._id}/refund/decide`, { decision: 'rejected' }), 400, 'cannot reject after approving');
  is(await api('Owner', 'PATCH', `/institutions/fees/${paid._id}/refund/decide`, { decision: 'refunded' }), 200, 'mark refunded');
  assert.deepEqual([(await model('Fee').findById(paid._id)).status, (await model('Fee').findById(paid._id)).refund.status], ['refunded', 'refunded']);
});

test('fee refund: a new request must not overwrite an open duplicate-payment refund', async () => {
  const fee = await newFee(1000, { status: 'paid', paidAmount: 1000, outstandingAmount: 0, paidAt: new Date(),
    refund: { status: 'requested', amount: 1000, reason: 'Duplicate JazzCash payment T1', duplicate: true, requestedAt: new Date() } });
  const r = await api('Kid', 'POST', `/institutions/fees/${fee._id}/refund/request`, { reason: 'I want my fee back' });
  const after = await model('Fee').findById(fee._id);
  assert.equal(after.refund.duplicate, true, `duplicate refund was overwritten (HTTP ${r.status}); refund now: ${JSON.stringify(after.refund)}`);
});

// ───────────────────────────── 5. Recruitment invoice (institute → CareerZ → agent)
async function newInvoice(extra = {}) {
  const commission = await model('Commission').create({ agent: u.Agent._id, job: oid(), amount: 45000, currency: 'PKR', status: 'pending', source: 'recruitment_agreement', grossFee: 50000, platformFee: 5000 });
  return model('RecruitmentInvoice').create({ number: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, agreement: oid(), institution: school._id, agent: u.Agent._id, commission: commission._id,
    currency: 'PKR', grossFee: 50000, platformFee: 5000, processingCharges: 0, agentEarning: 45000, dueDate: new Date(Date.now() + 7 * 864e5), status: 'issued', ...extra });
}
const proof = (amount = 50000, reference = 'IBFT-1') => ({ reference, amount, paidOn: new Date().toISOString(), file: { name: 'proof.png', data: 'data:image/png;base64,iVBORw0KGgo=' } });

test('recruitment wallet payment: agent and CareerZ are paid at once; nothing is held', async () => {
  await model('Wallet').deleteMany({});
  await model('Wallet').create({ user: u.Owner._id, currency: 'PKR', available: 60000 });
  const inv = await newInvoice();
  const rich = await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`);
  is(rich, 200, 'pay from wallet');
  assert.equal(await walletOf('Owner'), 10000, '50,000 paid');
  is(await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 409, 'pay twice');
  assert.equal((await model('RecruitmentInvoice').findById(inv._id)).status, 'paid', 'no admin approval');
  assert.equal(await walletOf('Agent'), 45000, 'agent share');
  assert.equal(await walletOf('CareerZ'), 5000, 'CareerZ commission');
  assert.equal((await model('Commission').findById(inv.commission)).status, 'paid');

  const inv2 = await newInvoice();
  is(await api('Owner', 'POST', `/recruitment/invoices/${inv2._id}/pay-wallet`), 422, 'only 10,000 left');
  await model('Wallet').updateOne({ user: u.Owner._id, currency: 'PKR' }, { $inc: { available: 40000 } });
  is(await api('Owner', 'POST', `/recruitment/invoices/${inv2._id}/pay-wallet`), 200, 'pay after top-up');
  assert.equal(await walletOf('Owner'), 0, 'paid');
  assert.equal(await walletOf('Agent'), 90000, 'agent paid for both');
  await model('Wallet').deleteMany({});
});

test('recruitment wallet payment: double-click "Pay from wallet" charges the institute once', async () => {
  await model('Wallet').deleteMany({});
  await model('Wallet').create({ user: u.Owner._id, currency: 'PKR', available: 200000 });
  const inv = await newInvoice();
  const results = await Promise.all([1, 2].map(() => api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`)));
  assert.equal(await walletOf('Owner'), 150000, `charged ${(200000 - await walletOf('Owner')) / 50000} times; responses ${results.map((r) => r.status)}`);
  await model('Wallet').deleteMany({});
});

test('recruitment wallet payment: double-click "Approve" pays the agent once', async () => {
  await model('Wallet').deleteMany({});
  await model('Wallet').create({ user: u.Owner._id, currency: 'PKR', available: 50000 });
  const inv = await newInvoice();
  is(await api('Owner', 'POST', `/recruitment/invoices/${inv._id}/pay-wallet`), 200, 'pay');
  const results = await Promise.all([api('CareerZ', 'POST', `/admin/recruitment/invoices/${inv._id}/verify`, { decision: 'approve' }), api('FinanceStaff', 'POST', `/admin/recruitment/invoices/${inv._id}/verify`, { decision: 'approve' })]);
  assert.equal(await walletOf('Agent'), 45000, `agent received ${await walletOf('Agent')}; responses ${results.map((r) => r.status)}`);
  await model('Wallet').deleteMany({});
});

// ───────────────────────────── 6. Agent commission withdrawal (after a bank-proof invoice)
test('agent withdrawal: one request per available balance; admin pays it once', async () => {
  await model('Commission').deleteMany({});
  await model('Commission').create({ agent: u.Agent._id, job: oid(), amount: 45000, currency: 'PKR', status: 'available', source: 'recruitment_agreement' });
  const body = { currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'PK36SCBL0000001123456702', accountTitle: 'Agent Name' };
  is(await api('Agent', 'POST', '/commissions/withdraw', { ...body, accountTitle: '' }), 422, 'no account name');
  const first = await api('Agent', 'POST', '/commissions/withdraw', body);
  is(first, 201, 'request');
  const second = await api('Agent', 'POST', '/commissions/withdraw', body);
  assert.notEqual(second.status, 201, 'a second withdrawal for the SAME 45,000 was accepted');
  await model('Withdrawal').deleteMany({ _id: { $ne: first.body.data._id } });

  const path = `/commissions/withdrawals/${first.body.data._id}/status`;
  is(await api('Agent', 'PATCH', path, { status: 'paid' }), 403, 'agent cannot mark paid');
  is(await api('CareerZ', 'PATCH', path, { status: 'paid' }), 200, 'admin paid');
  assert.equal((await model('Commission').findOne({ agent: u.Agent._id })).status, 'paid');
  const undo = await api('CareerZ', 'PATCH', path, { status: 'rejected' });
  assert.notEqual(undo.status, 200, 'a PAID withdrawal could be switched to rejected');
});

test('agent withdrawal: only finance should mark a payout as paid', async () => {
  await model('Commission').deleteMany({});
  await model('Withdrawal').deleteMany({});
  await model('Commission').create({ agent: u.Agent._id, job: oid(), amount: 1000, currency: 'PKR', status: 'available', source: 'recruitment_agreement' });
  const w = await api('Agent', 'POST', '/commissions/withdraw', { currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'ACC', accountTitle: 'Agent' });
  is(await api('SupportStaff', 'PATCH', `/commissions/withdrawals/${w.body.data._id}/status`, { status: 'paid' }), 403, 'support (non-finance) staff marked a payout paid');
});

// ───────────────────────────── 7. Donations (donor pays by bank; the receiver confirms)
async function openRequest(by = 'Kid', requiredAmount = 10000) {
  return model('FundingRequest').create({ requestedBy: u[by]._id, requestType: 'student', category: 'scholarship', title: `Help ${Math.random()}`, requiredAmount, currency: 'PKR', verificationStatus: 'verified', status: 'open' });
}
const gift = (amount, reference = 'DON-1') => ({ amount, paymentMethod: 'bank_transfer', reference, proofUrl: 'https://f.test/don.jpg' });

// ───────────────────────────── 8. Marketplace (seller self-reports payment; CareerZ pays out)
async function product(price = 1000) {
  return model('Product').create({ seller: u.Seller._id, title: `Book ${Math.random()}`, category: 'books', price, currency: 'PKR', stock: 10, status: 'active' });
}

test('marketplace: only the order\'s seller updates it; buyers cannot', async () => {
  const p = await product();
  const order = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  is(await api('Buyer', 'PATCH', `/marketplace/orders/${order._id}/status`, { status: 'delivered' }), 403, 'buyer');
  is(await api('Buyer', 'PATCH', `/marketplace/orders/${order._id}/payment-status`, { paymentStatus: 'paid' }), 403, 'buyer');
  is(await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/payment-status`, { paymentStatus: 'nope' }), 422, 'bad status');
  is(await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/payment-status`, { paymentStatus: 'paid' }), 403, 'only CareerZ marks it paid (after the receipts)');
});

test('marketplace: a seller cannot order their own product', async () => {
  const p = await product();
  const r = await api('Seller', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 });
  assert.notEqual(r.status, 201, 'seller placed an order on their own listing');
});

test('marketplace: an order whose payment never arrived must not become withdrawable money', async () => {
  await model('Order').deleteMany({});
  await model('SellerWithdrawal').deleteMany({});
  const p = await product(1000);
  const order = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  is(await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/status`, { status: 'delivered' }), 200, 'delivered, payment still pending');
  const wallet = (await api('Seller', 'GET', '/marketplace/sellers/mine/wallet')).body.data;
  assert.equal(wallet.PKR?.availableBalance || 0, 0, `unpaid order counted as available: ${JSON.stringify(wallet)}`);
});

test('marketplace withdrawal: one request at a time; a paid payout is final', async () => {
  await model('Order').deleteMany({});
  await model('SellerWithdrawal').deleteMany({});
  const p = await product(1000);
  const order = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  await model('Order').updateOne({ _id: order._id }, { $set: { paymentStatus: 'paid' } }); // CareerZ approved the buyer's receipts
  await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/status`, { status: 'delivered' });
  const body = { currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'ACC-1', accountTitle: 'Seller' };
  const first = await api('Seller', 'POST', '/marketplace/sellers/mine/withdraw', body);
  is(first, 201, 'withdraw available balance');
  is(await api('Seller', 'POST', '/marketplace/sellers/mine/withdraw', body), 422, 'nothing left after the request');
  const path = `/marketplace/sellers/withdrawals/${first.body.data._id}/status`;
  is(await api('Seller', 'PATCH', path, { status: 'paid' }), 403, 'seller cannot mark paid');
  is(await api('CareerZ', 'PATCH', path, { status: 'paid' }), 200, 'admin paid');
  const undo = await api('CareerZ', 'PATCH', path, { status: 'rejected' });
  assert.notEqual(undo.status, 200, 'a PAID seller payout could be switched to rejected (making the money withdrawable again)');
});

test('marketplace withdrawal: double-click "Withdraw" creates one request', async () => {
  await model('Order').deleteMany({});
  await model('SellerWithdrawal').deleteMany({});
  const p = await product(2000);
  const order = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  await model('Order').updateOne({ _id: order._id }, { $set: { paymentStatus: 'paid' } }); // CareerZ approved the buyer's receipts
  await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/status`, { status: 'delivered' });
  const body = { currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'ACC-2', accountTitle: 'Seller' };
  await Promise.all([1, 2].map(() => api('Seller', 'POST', '/marketplace/sellers/mine/withdraw', body)));
  assert.equal(await model('SellerWithdrawal').countDocuments({}), 1, 'two withdrawal requests for the same money');
});

// ───────────────────────────── 9. Salary paid by bank / cash (teacher confirms receipt)
async function payslip(net = 50000) {
  return model('Payslip').create({ institution: school._id, staff: u.Tutor._id, month: 9, year: 2026, basicSalary: net, netAmount: net, currency: 'PKR', generatedBy: u.Owner._id });
}

test('salary: institute reports with reference/proof; only the teacher confirms or rejects', async () => {
  const slip = await payslip();
  const path = `/institutions/payroll/${slip._id}/pay`;
  is(await api('Stranger', 'PATCH', path, { paymentMethod: 'cash', reference: 'S1' }), 403, 'not institute');
  is(await api('Owner', 'PATCH', path, { paymentMethod: 'cash' }), 422, 'no reference');
  is(await api('Owner', 'PATCH', path, { paymentMethod: 'bank_transfer', reference: 'S1', proofUrl: 'https://f.test/s.jpg' }), 422, 'teacher has no bank details saved');
  is(await api('Owner', 'PATCH', path, { paymentMethod: 'cash', reference: 'S1' }), 200, 'cash reported');
  assert.equal((await model('Payslip').findById(slip._id)).status, 'processing', 'not paid until the teacher confirms');
  is(await api('Owner', 'PATCH', `/teachers/me/payslips/${slip._id}/verify-payment`, { decision: 'verify' }), 404, 'institute cannot confirm for the teacher');
  is(await api('Tutor', 'PATCH', `/teachers/me/payslips/${slip._id}/verify-payment`, { decision: 'reject' }), 422, 'reject without reason');
  is(await api('Tutor', 'PATCH', `/teachers/me/payslips/${slip._id}/verify-payment`, { decision: 'reject', rejectionReason: 'Not received' }), 200, 'teacher rejects');
  assert.equal((await model('Payslip').findById(slip._id)).status, 'pending');
  is(await api('Owner', 'PATCH', path, { paymentMethod: 'cash', reference: 'S2' }), 200, 'report again');
  is(await api('Tutor', 'PATCH', `/teachers/me/payslips/${slip._id}/verify-payment`, { decision: 'verify' }), 200, 'teacher confirms');
  assert.equal((await model('Payslip').findById(slip._id)).status, 'paid');
  is(await api('Owner', 'PATCH', path, { paymentMethod: 'cash', reference: 'S3' }), 409, 'already paid');
});

// ───────────────────────────── 10. Wallet withdrawal (admin pays out by hand)
test('wallet withdrawal: admin-only review; approve completes, reject returns the money', async () => {
  await model('Wallet').deleteMany({});
  await model('Wallet').create({ user: u.Kid._id, currency: 'PKR', available: 1000 });
  is(await api('Kid', 'POST', '/wallet/withdraw', { amount: 100, currency: 'PKR' }), 422, 'no payout account saved yet');
  is(await api('Kid', 'PUT', '/wallet/payout-account', { method: 'bank_transfer', bankName: 'UBL', accountTitle: 'Kid Student', accountNumber: 'PK78UNIL01090002722708' }), 422, 'a short IBAN');
  is(await api('Kid', 'PUT', '/wallet/payout-account', { method: 'bank_transfer', bankName: 'Some Bank', accountTitle: 'Kid Student', accountNumber: '0833272270819' }), 422, 'an unknown bank');
  is(await api('Kid', 'PUT', '/wallet/payout-account', { method: 'mobile_wallet', bankName: 'JazzCash', accountTitle: 'Kid Student', accountNumber: '0300123' }), 422, 'a short wallet number');
  is(await api('Kid', 'PUT', '/wallet/payout-account', { method: 'other', accountTitle: 'Kid Student', accountNumber: 'anything' }), 422, 'no free-text "other" method');
  is(await api('Kid', 'PUT', '/wallet/payout-account', { method: 'bank_transfer', bankName: 'UBL', accountTitle: 'Kid Student', accountNumber: 'pk78 unil 0109 0002 7227 0819' }), 200, 'a valid IBAN, typed with spaces');
  const saved = await api('Kid', 'GET', '/wallet/payout-account');
  assert.equal(saved.body.data.account.accountNumber, 'PK78UNIL0109000272270819', 'stored without spaces');
  const body = { amount: 400, currency: 'PKR' };
  is(await api('Kid', 'POST', '/wallet/withdraw', { ...body, amount: 5000 }), 422, 'more than the balance');
  const w1 = await api('Kid', 'POST', '/wallet/withdraw', body);
  const w2 = await api('Kid', 'POST', '/wallet/withdraw', { ...body, method: 'mobile_wallet', bankName: 'Easypaisa', accountTitle: 'Kid Student', accountNumber: '+92 300 1234567' });
  assert.match((await model('WalletTransaction').findById(w1.body.data.id)).payoutDetails, /Kid Student — UBL account PK78UNIL0109000272270819/);
  assert.match((await model('WalletTransaction').findById(w2.body.data.id)).payoutDetails, /Easypaisa wallet 03001234567/);
  is(w1, 200, 'w1'); is(w2, 200, 'w2');
  is(await api('Owner', 'GET', '/wallet/withdrawals/pending'), 403, 'non-admin list');
  is(await api('Owner', 'PATCH', `/wallet/withdrawals/${w1.body.data.id}/review`, { decision: 'approved' }), 403, 'non-admin review');
  is(await api('CareerZ', 'PATCH', `/wallet/withdrawals/${w1.body.data.id}/review`, { decision: 'approved' }), 422, 'approve needs the transfer id');
  is(await api('CareerZ', 'PATCH', `/wallet/withdrawals/${w1.body.data.id}/review`, { decision: 'approved', transferReference: 'UBL-IBFT-778812' }), 200, 'approve');
  assert.equal((await model('WalletTransaction').findById(w1.body.data.id)).payoutReference, 'UBL-IBFT-778812');
  is(await api('CareerZ', 'PATCH', `/wallet/withdrawals/${w2.body.data.id}/review`, { decision: 'rejected' }), 200, 'reject');
  is(await api('CareerZ', 'PATCH', `/wallet/withdrawals/${w1.body.data.id}/review`, { decision: 'rejected' }), 400, 'review twice');
  const w = await model('Wallet').findOne({ user: u.Kid._id, currency: 'PKR' });
  assert.deepEqual([w.available, w.pending], [600, 0], 'paid 400 out, 400 returned');
});

test('agent withdrawal: a rejected request frees the commissions for a new request', async () => {
  await model('Commission').deleteMany({});
  await model('Withdrawal').deleteMany({});
  await model('Commission').create({ agent: u.Agent._id, job: oid(), amount: 2000, currency: 'PKR', status: 'available', source: 'recruitment_agreement' });
  const body = { currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'ACC', accountTitle: 'Agent' };
  const first = await api('Agent', 'POST', '/commissions/withdraw', body);
  is(first, 201, 'request');
  const totals = (await api('Agent', 'GET', '/commissions/mine')).body.data.totalsByCurrency.PKR;
  assert.deepEqual([totals.available, totals.withdrawing], [0, 2000], 'reserved money is not shown as available');
  is(await api('FinanceStaff', 'PATCH', `/commissions/withdrawals/${first.body.data._id}/status`, { status: 'rejected' }), 200, 'finance rejects (wrong account)');
  is(await api('FinanceStaff', 'PATCH', `/commissions/withdrawals/${first.body.data._id}/status`, { status: 'paid' }), 409, 'a rejected request cannot be paid later');
  is(await api('Agent', 'POST', '/commissions/withdraw', { ...body, payoutDetails: 'ACC-FIXED' }), 201, 'request again with the right account');
});

test('marketplace: a refunded order is removed from earnings once, not charged twice', async () => {
  await model('Order').deleteMany({});
  await model('SellerWithdrawal').deleteMany({});
  const p = await product(1000);
  const kept = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  const returned = (await api('Buyer', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1 })).body.data;
  for (const o of [kept, returned]) {
    await model('Order').updateOne({ _id: o._id }, { $set: { paymentStatus: 'paid' } });
    await api('Seller', 'PATCH', `/marketplace/orders/${o._id}/status`, { status: 'delivered' });
  }
  is(await api('Buyer', 'POST', `/marketplace/orders/${returned._id}/request-refund`, { reason: 'Damaged' }), 200, 'buyer asks for a refund');
  is(await api('Seller', 'PATCH', `/marketplace/orders/${returned._id}/refund-response`, { approve: true }), 200, 'seller approves');
  const wallet = (await api('Seller', 'GET', '/marketplace/sellers/mine/wallet')).body.data.PKR;
  const commission = Number((await api('Seller', 'GET', '/marketplace/commission-rate')).body.data.rate ?? 10);
  assert.equal(wallet.availableBalance, 1000 - (1000 * commission) / 100, 'only the kept order counts, the refund is not subtracted again');
});

test('admin payout queues: finance sees open agent and seller payouts; others cannot', async () => {
  await model('Withdrawal').deleteMany({});
  await model('SellerWithdrawal').deleteMany({});
  await model('Withdrawal').create({ agent: u.Agent._id, amount: 500, currency: 'PKR', payoutMethod: 'bank_transfer', payoutDetails: 'Agent — ACC' });
  await model('SellerWithdrawal').create({ seller: u.Seller._id, amount: 700, currency: 'PKR', payoutMethod: 'mobile_wallet', payoutDetails: 'Seller — 0300' });
  for (const [path, who] of [['/commissions/withdrawals/open', 'Agent'], ['/marketplace/sellers/withdrawals/open', 'Seller']]) {
    is(await api('SupportStaff', 'GET', path), 403, `support staff ${path}`);
    is(await api(who, 'GET', path), 403, `${who} ${path}`);
    const r = await api('FinanceStaff', 'GET', path);
    is(r, 200, `finance ${path}`);
    assert.equal(r.body.data.length, 1);
    assert.ok(r.body.data[0][who === 'Agent' ? 'agent' : 'seller'].fullName, 'shows who to pay');
  }
});

// ───────────────────────────── Gateway course and tutoring payments reach the seller's wallet
test('commission rates: Super Admin sets course, tutoring and donation rates; others cannot', async () => {
  is(await api('Owner', 'GET', '/admin/commission-rates'), 403, 'institute owner');
  is(await api('FinanceStaff', 'PATCH', '/admin/commission-rates', { course: 5 }), 403, 'finance staff cannot change rates');
  is(await api('CareerZ', 'PATCH', '/admin/commission-rates', { course: 150 }), 422, 'over 100');
  const r = await api('CareerZ', 'PATCH', '/admin/commission-rates', { course: 20, tutoring: 10 });
  is(r, 200, 'save');
  assert.deepEqual([r.body.data.course, r.body.data.tutoring, r.body.data.donation], [20, 10, 0]);
  is(await api('CareerZ', 'PATCH', '/admin/commission-rates', { fee: 7, marketplace: 12, recruitment: 9 }), 200, 'every service from one place');
  const all = (await api('FinanceStaff', 'GET', '/admin/commission-rates?detail=1')).body.data;
  assert.deepEqual([all.rates.fee, all.rates.marketplace, all.rates.recruitment], [7, 12, 9]);
  assert.ok(all.services.every((s) => s.label && s.about), 'each service is explained');
  await model('Setting').deleteMany({ key: { $in: ['institution_fee_commission_percent', 'marketplace_commission_percent', 'recruitment_platform_fee_percent'] } });
  is(await api('FinanceStaff', 'GET', '/admin/commission-rates'), 200, 'finance staff can see them');
});

test('gateway course sale and tutoring fee: seller paid less commission, once', async () => {
  await model('Wallet').deleteMany({});
  const { settleCoursePurchase, settleTutoringFee } = require('../src/controllers/webhook.controller');
  const course = await model('Course').create({ title: 'Paid Course', teacher: u.Tutor._id, institution: school._id, price: 2000, currency: 'PKR' });
  const purchase = await model('CoursePurchase').create({ student: u.Kid._id, course: course._id, amountMinor: 200000, currency: 'PKR', status: 'pending', provider: 'jazzcash', providerCheckoutId: 'JC-CHK-1' });
  const run = (fn) => mongoose.connection.transaction(fn);
  await run(async (s) => settleCoursePurchase(await model('CoursePurchase').findById(purchase._id).session(s), 'JC-COURSE-1', s));
  await run(async (s) => settleCoursePurchase(await model('CoursePurchase').findById(purchase._id).session(s), 'JC-COURSE-1', s));
  assert.equal(await walletOf('Owner'), 1600, 'the course belongs to the institute: 2000 less 20%, once');
  const link = await model('TeacherStudentLink').create({ teacher: u.Tutor._id, student: u.Kid._id, course: course._id, status: 'active', feeAmount: 3000, feeCurrency: 'PKR' });
  await run(async (s) => settleTutoringFee(await model('TeacherStudentLink').findById(link._id).session(s), { receiptId: 'JC-TUT-1', payerId: u.Kid._id, amount: 3000, currency: 'PKR' }, s));
  await run(async (s) => settleTutoringFee(await model('TeacherStudentLink').findById(link._id).session(s), { receiptId: 'JC-TUT-1', payerId: u.Kid._id, amount: 3000, currency: 'PKR' }, s));
  assert.equal(await walletOf('Tutor'), 2700, 'tutor: 3000 less 10%, once');
  await model('Setting').deleteMany({ key: { $in: ['course_commission_percent', 'tutoring_commission_percent'] } });
});
