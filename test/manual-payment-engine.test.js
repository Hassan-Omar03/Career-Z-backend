const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Manual payments over real HTTP: CareerZ's fee to the CareerZ account, the price to the seller's
// own account, both receipts checked by a CareerZ finance admin before anything is granted.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
mock.method(notifications, 'notifyParentsOfStudent', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);

let mongo, server, base, school;
const u = {};
async function account(name, roles, extra = {}) {
  roles = [].concat(roles);
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@mp.test`, passwordHash: 'x', emailVerified: true, roles, ...extra });
  for (const role of roles) {
    await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
    await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
  }
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const is = (r, code, msg) => assert.equal(r.status, code, `${msg} → ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount, extra = {}) => ({ amount, transactionId: `TXN${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'receipt.png', data: PNG }, ...extra });
const walletOf = async (who, cur = 'PKR') => (await model('Wallet').findOne({ user: u[who]._id, currency: cur }))?.available || 0;
const bank = { method: 'bank_transfer', bankName: 'HBL', accountTitle: 'Owner Account', accountNumber: 'PK36HABB0000001123456702' };
const newFee = (amount) => model('Fee').create({ institution: school._id, student: u.Kid._id, recordedBy: u.Owner._id, title: `Fee ${amount}`, amount, currency: 'PKR', status: 'pending', dueDate: new Date(Date.now() + 864e5) });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('CareerZ', 'super_admin');
  await account('FinanceStaff', 'platform_staff');
  await account('SupportStaff', 'platform_staff');
  await model('StaffProfile').create({ user: u.FinanceStaff._id, departments: ['finance'], active: true, addedBy: u.CareerZ._id });
  await model('StaffProfile').create({ user: u.SupportStaff._id, departments: ['support'], active: true, addedBy: u.CareerZ._id });
  await account('Owner', 'institution_owner', { phone: '03001112233' });
  await account('Kid', 'student');
  await account('Stranger', 'student');
  await account('Tutor', 'teacher', { phone: '03004445566' });
  await account('Seller', 'marketplace_seller', { phone: '03007778899' });
  school = await model('Institution').create({ name: 'Manual School', slug: 'mp-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  await model('Setting').create({ key: 'institution_fee_commission_percent', value: 10 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('CareerZ account: only the Super Admin sets it; nothing can be paid before it exists', async () => {
  const fee = await newFee(1000);
  is(await api('Kid', 'GET', `/manual-payments/quote/fee/${fee._id}`), 503, 'no CareerZ account yet');
  is(await api('FinanceStaff', 'PUT', '/manual-payments/platform-account', { accountTitle: 'X', bankName: 'UBL', accountNumber: '123456789' }), 403, 'finance staff');
  is(await api('CareerZ', 'PUT', '/manual-payments/platform-account', { accountTitle: 'Muhammad Asad Ullah', bankName: 'UBL', accountNumber: '0833272270819', iban: 'PK78 UNIL 0109 0002 7227 0819', qr: PNG }), 200, 'save');
  const acc = (await api('Kid', 'GET', '/manual-payments/platform-account')).body.data;
  assert.equal(acc.iban, 'PK78UNIL0109000272270819');
});

test('fee: CareerZ fee first; the seller account opens only after CareerZ confirms it; every rule enforced', async () => {
  const fee = await newFee(1000);
  is(await api('Kid', 'GET', `/manual-payments/quote/fee/${fee._id}`), 409, 'the institute has no receiving account yet');
  await model('User').updateOne({ _id: u.Owner._id }, { $set: { payoutAccount: bank } });
  let q = (await api('Kid', 'GET', `/manual-payments/quote/fee/${fee._id}`)).body.data;
  assert.deepEqual([q.commission, q.sellerAmount, q.total, q.stage], [100, 1000, 1100, 'commission'], 'CareerZ 10% on top; pay CareerZ first');
  assert.equal(q.seller.account, null, 'the seller account is hidden until the CareerZ fee is confirmed');
  assert.equal(JSON.stringify(q).includes(bank.accountNumber), false, 'not leaked anywhere in the reply');
  assert.equal(q.careerzAccount.accountTitle, 'Muhammad Asad Ullah');
  const path = `/manual-payments/fee/${fee._id}`;
  is(await api('Stranger', 'POST', path, { phone: '03001234567', commission: leg(100) }), 403, 'not the student or a parent');
  is(await api('Kid', 'POST', path, { commission: leg(100) }), 422, 'no phone');
  is(await api('Kid', 'POST', path, { phone: '03001234567', seller: leg(1000) }), 422, 'cannot skip the CareerZ fee');
  is(await api('Kid', 'POST', path, { phone: '03001234567', commission: leg(90) }), 422, 'wrong CareerZ fee amount');
  is(await api('Kid', 'POST', path, { phone: '03001234567', commission: leg(100, { file: null }) }), 422, 'no receipt file');
  is(await api('Kid', 'POST', path, { phone: '03001234567', commission: leg(100, { paidOn: new Date(Date.now() - 60 * 864e5).toISOString() }) }), 422, 'old transfer date');
  const used = leg(100);
  const sent = await api('Kid', 'POST', path, { phone: '03001234567', commission: used });
  is(sent, 201, 'CareerZ fee receipt sent');
  const id = sent.body.data._id;
  assert.equal(sent.body.data.status, 'commission_submitted');
  q = (await api('Kid', 'GET', `/manual-payments/quote/fee/${fee._id}`)).body.data;
  assert.deepEqual([q.stage, q.seller.account], ['waiting', null], 'still hidden while CareerZ checks the fee');
  is(await api('Kid', 'POST', path, { phone: '03001234567', seller: leg(1000) }), 409, 'cannot pay the seller before the fee is confirmed');
  const fee2 = await newFee(500);
  is(await api('Kid', 'POST', `/manual-payments/fee/${fee2._id}`, { phone: '03001234567', commission: leg(50, { transactionId: used.transactionId }) }), 409, 'a receipt cannot be reused');
  assert.equal((await model('User').findById(u.Kid._id)).phone, '03001234567', 'phone saved for next time');
  assert.equal(await api('Owner', 'GET', '/manual-payments/incoming').then((r) => r.body.data.length), 0, 'the seller sees nothing yet');

  // Step 1 decision: finance confirms the CareerZ fee.
  is(await api('SupportStaff', 'GET', '/manual-payments/admin'), 403, 'support staff');
  assert.ok((await api('FinanceStaff', 'GET', '/manual-payments/admin')).body.data.some((m) => m._id === id), 'in the queue to check');
  is(await api('Owner', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'approve' }), 403, 'institute cannot approve');
  const fees = await Promise.all([1, 2].map(() => api('FinanceStaff', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'approve' })));
  assert.deepEqual(fees.map((r) => r.status).sort(), [200, 409], 'two clicks confirm the fee once');
  assert.equal((await model('Fee').findById(fee._id)).status, 'pending', 'the fee is not paid by the CareerZ fee alone');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'approve' }), 409, 'nothing to approve until the seller is paid');

  // Step 2: now the seller account is shown and the seller receipt is taken.
  q = (await api('Kid', 'GET', `/manual-payments/quote/fee/${fee._id}`)).body.data;
  assert.deepEqual([q.stage, q.seller.account.accountNumber], ['seller', bank.accountNumber]);
  is(await api('Kid', 'POST', path, { seller: leg(900) }), 422, 'wrong seller amount');
  is(await api('Kid', 'POST', path, { seller: leg(1000, { transactionId: used.transactionId }) }), 409, 'the CareerZ receipt cannot be reused for the seller');
  is(await api('Kid', 'POST', path, { seller: leg(1000) }), 201, 'seller receipt sent');
  is(await api('Kid', 'POST', path, { seller: leg(1000) }), 409, 'only once');

  const row = (await api('FinanceStaff', 'GET', '/manual-payments/admin')).body.data.find((m) => m._id === id);
  assert.deepEqual([row.status, row.payerSnapshot.phone, row.recipientSnapshot.phone, row.recipientSnapshot.account.accountNumber], ['submitted', '03001234567', '03001112233', bank.accountNumber]);

  // Receipts: admin both, buyer own, seller only theirs, stranger none.
  is(await api('FinanceStaff', 'GET', `/manual-payments/${id}/proof/commission`), 200, 'admin commission receipt');
  is(await api('Owner', 'GET', `/manual-payments/${id}/proof/seller`), 200, 'seller sees the receipt for their money');
  is(await api('Owner', 'GET', `/manual-payments/${id}/proof/commission`), 404, 'seller cannot see the CareerZ receipt');
  is(await api('Stranger', 'GET', `/manual-payments/${id}/proof/seller`), 404, 'stranger');

  // Seller says it did not arrive: approving then needs the admin's note.
  is(await api('Stranger', 'PATCH', `/manual-payments/${id}/confirm`, { received: true }), 404, 'only the seller confirms');
  is(await api('Owner', 'PATCH', `/manual-payments/${id}/confirm`, { received: false, note: 'Not in my statement' }), 200, 'seller denies');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'approve' }), 422, 'needs a note after the seller denied');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'reject' }), 422, 'reject needs a reason');
  const both = await Promise.all([1, 2].map(() => api('FinanceStaff', 'PATCH', `/manual-payments/${id}/decide`, { decision: 'approve', note: 'Called the institute, the money arrived late' })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], 'two clicks decide once');
  const paid = await model('Fee').findById(fee._id);
  assert.deepEqual([paid.status, paid.paidAmount, paid.escrowStatus], ['paid', 1000, 'released']);
  assert.ok(paid.receiptNumber);
  assert.equal(await walletOf('Owner'), 0, 'no wallet credit: the money is already in the institute bank');
  is(await api('Kid', 'POST', path, { phone: '03001234567', commission: leg(100) }), 400, 'a paid fee cannot be paid again');
});

test('reject at the CareerZ-fee step: the buyer can start again with a new receipt', async () => {
  const fee = await newFee(300);
  const path = `/manual-payments/fee/${fee._id}`;
  const first = await api('Kid', 'POST', path, { commission: leg(30) });
  is(first, 201, 'submit (phone remembered)');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${first.body.data._id}/decide`, { decision: 'reject', note: 'Receipt is blurry' }), 200, 'reject');
  is(await api('Kid', 'POST', path, { commission: leg(30) }), 201, 'pay again');
});

test('CareerZ items: wallet top-up, featured job, plan are paid in full to the CareerZ account', async () => {
  const top = await api('Kid', 'GET', '/manual-payments/quote/wallet_topup?amount=750&currency=PKR');
  assert.deepEqual([top.body.data.commission, top.body.data.sellerAmount, top.body.data.seller], [750, 0, null]);
  const t = await api('Kid', 'POST', '/manual-payments/wallet_topup', { amount: 750, currency: 'PKR', commission: leg(750) });
  is(t, 201, 'top-up');
  is(await api('Kid', 'POST', '/manual-payments/wallet_topup', { amount: 100, currency: 'PKR', commission: leg(100) }), 409, 'one open top-up at a time');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${t.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  assert.equal(await walletOf('Kid'), 750);

  await model('Setting').create({ key: 'featured_job_fee_usd', value: 20 });
  const job = await model('Job').create({ title: 'Teacher', company: 'Manual School', description: 'x', postedBy: u.Owner._id, institution: school._id, status: 'active', location: 'Lahore', country: 'PK', type: 'full_time' });
  const fq = await api('Owner', 'GET', `/manual-payments/quote/featured_job/${job._id}`);
  is(fq, 200, 'featured quote');
  const f = await api('Owner', 'POST', `/manual-payments/featured_job/${job._id}`, { commission: leg(fq.body.data.commission) });
  is(f, 201, 'featured submit');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${f.body.data._id}/decide`, { decision: 'approve' }), 200, 'featured approve');
  assert.equal((await model('Job').findById(job._id)).featured, true);
});

test('course, tutoring, marketplace and donation: granted only after approval; sellers cannot self-confirm orders', async () => {
  await model('Setting').create({ key: 'course_commission_percent', value: 20 });
  const course = await model('Course').create({ title: 'Paid Course', teacher: u.Tutor._id, price: 2000, currency: 'PKR', published: true, isFree: false });
  is(await api('Kid', 'GET', `/manual-payments/quote/course/${course._id}`), 409, 'tutor has no receiving account');
  await model('User').updateOne({ _id: u.Tutor._id }, { $set: { payoutAccount: { ...bank, accountTitle: 'Tutor', accountNumber: '0833272270000' } } });
  const c = await api('Kid', 'POST', `/manual-payments/course/${course._id}`, { commission: leg(400) });
  is(c, 201, 'course: CareerZ fee first');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${c.body.data._id}/decide`, { decision: 'approve' }), 200, 'fee confirmed');
  is(await api('Kid', 'POST', `/manual-payments/course/${course._id}`, { seller: leg(2000) }), 201, 'then the tutor');
  assert.equal(await model('Enrollment').exists({ student: u.Kid._id, course: course._id }), null, 'not enrolled yet');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${c.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  assert.ok(await model('Enrollment').exists({ student: u.Kid._id, course: course._id }), 'enrolled');

  const link = await model('TeacherStudentLink').create({ teacher: u.Tutor._id, student: u.Kid._id, course: course._id, status: 'active', feeAmount: 3000, feeCurrency: 'PKR' });
  const t = await api('Kid', 'POST', `/manual-payments/tutoring/${link._id}`, { seller: leg(3000) });
  is(t, 201, 'tutoring with no commission set: only the tutor transfer');
  is(await api('FinanceStaff', 'PATCH', `/manual-payments/${t.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  assert.ok((await model('TeacherStudentLink').findById(link._id)).feePaidAt);

  await model('User').updateOne({ _id: u.Seller._id }, { $set: { payoutAccount: { method: 'mobile_wallet', bankName: 'JazzCash', accountTitle: 'Seller', accountNumber: '03007778899' } } });
  const product = await model('Product').create({ seller: u.Seller._id, title: 'Book', price: 500, currency: 'PKR', category: 'books', stock: 5, status: 'active' });
  const order = await model('Order').create({ buyer: u.Kid._id, seller: u.Seller._id, product: product._id, quantity: 1, unitPrice: 500, totalPrice: 500, currency: 'PKR' });
  is(await api('Seller', 'PATCH', `/marketplace/orders/${order._id}/payment-status`, { paymentStatus: 'paid' }), 403, 'seller cannot mark it paid');
  const o = await api('Kid', 'POST', `/manual-payments/marketplace_order/${order._id}`, { seller: leg(500) });
  is(o, 201, 'order submit');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${o.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  assert.equal((await model('Order').findById(order._id)).paymentStatus, 'paid');

  await model('User').updateOne({ _id: u.Stranger._id }, { $set: { payoutAccount: { ...bank, accountTitle: 'Stranger', accountNumber: '0833270000000' } } });
  const request = await model('FundingRequest').create({ requestedBy: u.Stranger._id, title: 'Help', description: 'x', requiredAmount: 1000, currency: 'PKR', status: 'open', verificationStatus: 'verified', category: 'scholarship', requestType: 'student' });
  is(await api('Stranger', 'POST', `/manual-payments/donation/${request._id}`, { amount: 200, seller: leg(200) }), 403, 'no self-donation');
  const d = await api('Kid', 'POST', `/manual-payments/donation/${request._id}`, { amount: 200, seller: leg(200) });
  is(d, 201, 'donation submit');
  is(await api('CareerZ', 'PATCH', `/manual-payments/${d.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  assert.equal((await model('FundingRequest').findById(request._id)).collectedAmount, 200);
});

test('old one-receipt flows are closed; online checkout is off; a fraudster can be suspended', async () => {
  const fee = await newFee(100);
  is(await api('Kid', 'POST', `/institution-fees/fees/${fee._id}/report-payment`, { amount: 100, method: 'bank_transfer', reference: 'R1', bankName: 'HBL', proofUrl: 'https://x/y.jpg' }), 410, 'old fee report');
  is(await api('Owner', 'PATCH', `/institutions/fees/${fee._id}/pay`, { paidVia: 'Cash', reference: 'C1', proofUrl: 'https://x/y.jpg' }), 410, 'old counter cash');
  is(await api('Kid', 'POST', `/payments/jazzcash/fees/${fee._id}/checkout`, { gateway: 'safepay' }), 503, 'online checkout off');
  is(await api('FinanceStaff', 'PATCH', `/users/${u.Stranger._id}/status`, { status: 'suspended' }), 403, 'finance staff cannot suspend');
  is(await api('CareerZ', 'PATCH', `/users/${u.Stranger._id}/status`, { status: 'suspended' }), 200, 'admin suspends');
  is(await api('Stranger', 'GET', '/manual-payments/mine'), 403, 'suspended account is locked out');
});
