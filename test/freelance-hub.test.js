const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// The whole Freelancer Hub through the real API, including the bank-transfer check and the wallet.
process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base; const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (r, code, msg = '') => { assert.equal(r.status, code, `${msg} → ${JSON.stringify(r.body).slice(0, 300)}`); return r.body?.data; };
async function account(name, role, approved = true) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@fl.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', phone: '+923001234567', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending_approval', approvedAt: approved ? new Date(Date.now() - 864e5 * 30) : null });
  await model('UserProfile').create({ user: u[name]._id, role, completed: approved, percent: approved ? 100 : 0 });
}
const packs = [{ tier: 'basic', name: 'Starter', price: 1000, deliveryDays: 3, revisions: 1, includes: 'One subject' }, { tier: 'premium', price: 5000, deliveryDays: 10, revisions: 3 }];
const service = (extra = {}) => ({ title: 'Online maths tuition', category: 'online_tuition', description: 'Clear maths lessons for matric students.', packages: packs, ...extra });
const wallet = async (who) => (await model('Wallet').findOne({ user: u[who]._id, currency: 'PKR' }).lean())?.available || 0;

// The buyer pays through the normal bank-transfer screen and an admin confirms it.
async function fund(who, milestoneId) {
  const quote = expect(await api(who, 'GET', `/manual-payments/quote/freelance_milestone/${milestoneId}`), 200, 'quote');
  const file = { name: 'r.png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
  const leg = { amount: quote.commission, transactionId: `TX${String(milestoneId).slice(-12)}`, paidOn: new Date().toISOString().slice(0, 10), file };
  const mp = expect(await api(who, 'POST', `/manual-payments/freelance_milestone/${milestoneId}`, { phone: '03001234567', commission: leg }), 201, 'submit');
  expect(await api('Admin', 'PATCH', `/manual-payments/${mp._id}/decide`, { decision: 'approve', note: 'Seen in the bank' }), 200, 'approve');
  return { quote, mp };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(['ManualPayment', 'FreelanceProposal', 'FreelanceDispute', 'Receipt', 'CommissionRule', 'Wallet'].map((n) => model(n).init()));
  await account('Teacher', 'teacher'); await account('Student', 'student'); await account('Employer', 'employer'); await account('Pending', 'teacher', false);
  u.Admin = await model('User').create({ fullName: 'Admin', email: 'admin@fl.test', passwordHash: 'x', emailVerified: true, roles: ['super_admin'], status: 'active' });
  await model('Setting').create([{ key: 'freelance_commission_percent', value: 10 }, { key: 'platform_payment_account', value: { method: 'bank', bankName: 'HBL', accountTitle: 'CareerZ', accountNumber: 'PK00' } }]);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('any verified account can sell; an unverified one cannot; the catalogue is public', async () => {
  expect(await api('Pending', 'POST', '/freelance/services', service()), 403, 'unverified');
  expect(await api('Teacher', 'POST', '/freelance/services', service({ title: 'x' })), 422, 'short title');
  expect(await api('Teacher', 'POST', '/freelance/services', service({ packages: [] })), 422, 'no package');
  const made = expect(await api('Teacher', 'POST', '/freelance/services', service()), 201);
  assert.equal(made.status, 'active', 'no per-post approval');
  const held = expect(await api('Student', 'POST', '/freelance/services', service({ title: 'Send advance payment first', description: 'Pay an advance fee on my easypaisa wallet number before work starts' })), 201);
  assert.equal(held.status, 'pending_review', 'the automatic check holds what looks wrong');
  const list = expect(await api(null, 'GET', '/freelance/services'), 200);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].startingAt, 1000);
  const page = expect(await api(null, 'GET', `/freelance/services/${made._id}`), 200);
  assert.equal(page.packages.length, 2);
  expect(await api(null, 'GET', `/freelance/services/${held._id}`), 404);
  expect(await api('Teacher', 'PUT', '/freelance/profile/me', { type: 'Trainer', headline: 'Maths teacher', skills: ['Maths'], portfolio: [{ title: 'Site', url: 'http://x' }] }), 422);
  expect(await api('Teacher', 'PUT', '/freelance/profile/me', { type: 'Trainer', headline: 'Maths teacher', skills: ['Maths'], portfolio: [{ title: 'Site', url: 'https://x.pk' }] }), 200);
  u.service = made;
});

test('package order: pay, CareerZ holds it, deliver, revision, approve, wallet, receipt, review', async () => {
  expect(await api('Teacher', 'POST', `/freelance/services/${u.service._id}/order`, { tier: 'basic' }), 403, 'own service');
  expect(await api('Student', 'POST', `/freelance/services/${u.service._id}/order`, { tier: 'gold' }), 422);
  const order = expect(await api('Student', 'POST', `/freelance/services/${u.service._id}/order`, { tier: 'basic' }), 201);
  const mId = order.milestones[0]._id;
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { note: 'early' }), 409, 'not paid yet');
  expect(await api('Employer', 'GET', `/freelance/orders/${order._id}`), 404, 'not a member');
  const { quote } = await fund('Student', mId);
  assert.equal(quote.price, 1100, 'commission on top');
  const receipt = (await model('Receipt').find({ transactionType: 'ManualPayment' }).lean())[0];
  assert.equal(receipt.grossAmount, 1100);
  assert.equal(receipt.platformCommission, 100);
  assert.equal(receipt.netAmount, 1000);
  assert.equal(receipt.recipientName, 'Teacher');
  let view = expect(await api('Student', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.milestones[0].status, 'funded');
  assert.equal(view.escrowBalance, 1000);
  assert.ok(view.milestones[0].dueDate, 'the delivery clock starts');
  assert.equal(await wallet('Teacher'), 0, 'held, not paid');
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/approve`), 409, 'nothing delivered');
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { note: 'x' }), 403);
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { files: [{ name: 'a', url: 'http://bad' }] }), 422);
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { note: 'Lesson one', files: [{ name: 'a.pdf', url: 'https://f.test/a.pdf' }] }), 200);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/revision`, { note: 'Add an example' }), 200);
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { note: 'Added' }), 200);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/revision`, { note: 'Change again' }), 409, 'package allows one');
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/review`, { rating: 5 }), 409, 'approve first');
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/approve`), 403);
  const [a, b] = await Promise.all([api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/approve`), api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/approve`)]);
  assert.ok([a.status, b.status].includes(200));
  assert.equal(await wallet('Teacher'), 1000, 'paid once even on a double click');
  view = expect(await api('Student', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.status, 'completed');
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/review`, { rating: 5, text: 'Very clear' }), 200);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/review`, { rating: 1 }), 409);
  const page = expect(await api(null, 'GET', `/freelance/services/${u.service._id}`), 200);
  assert.equal(page.reputation.rating, 5);
  assert.equal(page.reputation.completedOrders, 1);
  assert.equal(page.reputation.completionRate, 100);
  assert.ok(page.reputation.trustScore > 0);
  assert.equal(page.reviews[0].text, 'Very clear');
  const earned = expect(await api('Teacher', 'GET', '/freelance/earnings'), 200);
  assert.equal(earned.totals[0].released, 1000);
  assert.equal(expect(await api('Student', 'GET', '/receipts/mine'), 200).length, 1);
  assert.equal(expect(await api('Teacher', 'GET', '/receipts/mine'), 200).length, 1);
});

test('a freelance job: milestone proposal, accept, and client and freelancer can message each other', async () => {
  const job = await model('Job').create({ title: 'Write a syllabus', company: 'Acme', country: 'PK', type: 'freelance', status: 'active', postedBy: u.Employer._id, currency: 'PKR' });
  const normal = await model('Job').create({ title: 'Clerk', company: 'Acme', country: 'PK', type: 'full_time', status: 'active', postedBy: u.Employer._id });
  const body = { coverLetter: 'I wrote three syllabi for colleges last year.', fee: 3000, milestones: [{ title: 'Outline', amount: 1000 }, { title: 'Final', amount: 2000 }] };
  expect(await api('Teacher', 'POST', `/freelance/jobs/${normal._id}/proposals`, body), 404, 'only freelance jobs');
  expect(await api('Employer', 'POST', `/freelance/jobs/${job._id}/proposals`, body), 403, 'own job');
  expect(await api('Teacher', 'POST', `/freelance/jobs/${job._id}/proposals`, { ...body, fee: 2500 }), 422, 'must add up');
  const p = expect(await api('Teacher', 'POST', `/freelance/jobs/${job._id}/proposals`, body), 201);
  expect(await api('Teacher', 'POST', `/freelance/jobs/${job._id}/proposals`, body), 409, 'one per job');
  expect(await api('Student', 'POST', `/freelance/proposals/${p._id}/decision`, { decision: 'accept' }), 404, 'not the client');
  const received = expect(await api('Employer', 'GET', '/freelance/proposals/received'), 200);
  assert.equal(received.length, 1);
  const { order } = expect(await api('Employer', 'POST', `/freelance/proposals/${p._id}/decision`, { decision: 'accept' }), 200);
  assert.equal(order.milestones.length, 2);
  expect(await api('Employer', 'POST', `/freelance/proposals/${p._id}/decision`, { decision: 'decline' }), 409);
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/messages`, { text: 'Thanks, starting soon' }), 200);
  assert.equal(await require('../src/utils/messageAccess').canCommunicate(u.Employer._id, u.Teacher._id), true);
  u.jobOrder = order;
});

test('a dispute freezes the money; an admin refunds the client or pays the freelancer', async () => {
  const [one, two] = u.jobOrder.milestones;
  const before = await wallet('Teacher');
  await fund('Employer', one._id);
  expect(await api('Student', 'POST', `/freelance/orders/${u.jobOrder._id}/milestones/${one._id}/dispute`, { reason: 'I am not part of this order' }), 404);
  expect(await api('Employer', 'POST', `/freelance/orders/${u.jobOrder._id}/milestones/${one._id}/dispute`, { reason: 'short' }), 422);
  const d = expect(await api('Employer', 'POST', `/freelance/orders/${u.jobOrder._id}/milestones/${one._id}/dispute`, { reason: 'The freelancer stopped replying to me' }), 201);
  expect(await api('Teacher', 'POST', `/freelance/orders/${u.jobOrder._id}/milestones/${one._id}/submit`, { note: 'late' }), 409, 'frozen');
  expect(await api('Student', 'POST', `/freelance/admin/disputes/${d._id}`, { decision: 'refund', note: 'x' }), 403);
  expect(await api('Admin', 'POST', `/freelance/admin/disputes/${d._id}`, { decision: 'refund', note: 'No work was delivered' }), 200);
  expect(await api('Admin', 'POST', `/freelance/admin/disputes/${d._id}`, { decision: 'release', note: 'again' }), 409);
  assert.equal(await wallet('Employer'), 1000, 'refunded');
  assert.equal(await wallet('Teacher'), before, 'not paid');
  await fund('Employer', two._id);
  const d2 = expect(await api('Teacher', 'POST', `/freelance/orders/${u.jobOrder._id}/milestones/${two._id}/dispute`, { reason: 'The client will not answer my messages' }), 201);
  expect(await api('Admin', 'POST', `/freelance/admin/disputes/${d2._id}`, { decision: 'release', note: 'The work was delivered' }), 200);
  assert.equal(await wallet('Teacher'), before + 2000);
  const view = expect(await api('Employer', 'GET', `/freelance/orders/${u.jobOrder._id}`), 200);
  assert.equal(view.status, 'completed');
});

test('a delivery with no answer pays automatically; an unpaid order can be cancelled; an admin can remove a service', async () => {
  const start = await wallet('Teacher');
  const order = expect(await api('Student', 'POST', `/freelance/services/${u.service._id}/order`, { tier: 'premium' }), 201);
  const cancelled = expect(await api('Student', 'POST', `/freelance/services/${u.service._id}/order`, { tier: 'basic' }), 201);
  expect(await api('Teacher', 'POST', `/freelance/orders/${cancelled._id}/cancel`), 200);
  const mId = order.milestones[0]._id;
  await fund('Student', mId);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/cancel`), 409, 'money is held');
  expect(await api('Teacher', 'POST', `/freelance/orders/${order._id}/milestones/${mId}/submit`, { note: 'Done' }), 200);
  await model('FreelanceOrder').updateOne({ _id: order._id, 'milestones._id': mId }, { $set: { 'milestones.$.submittedAt': new Date(Date.now() - 8 * 864e5) } });
  const view = expect(await api('Teacher', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.milestones[0].status, 'approved');
  assert.equal(view.milestones[0].approvedBy, 'auto');
  assert.equal(await wallet('Teacher'), start + 5000);
  expect(await api('Teacher', 'POST', `/freelance/admin/services/${u.service._id}`, { action: 'remove', reason: 'x' }), 403);
  expect(await api('Admin', 'POST', `/freelance/admin/services/${u.service._id}`, { action: 'remove', reason: 'Fake service' }), 200);
  expect(await api(null, 'GET', `/freelance/services/${u.service._id}`), 404);
  expect(await api('Teacher', 'POST', `/freelance/services/${u.service._id}/status`, { status: 'active' }), 409);
  const overview = expect(await api('Admin', 'GET', '/freelance/admin/overview'), 200);
  assert.ok(overview.disputes.length >= 2);
  assert.ok(overview.orders.length >= 3);
});

test('a commission rule for freelance changes what the client pays', async () => {
  const s = expect(await api('Employer', 'POST', '/freelance/services', service({ title: 'Syllabus review', category: 'writing' })), 201);
  const order = expect(await api('Student', 'POST', `/freelance/services/${s._id}/order`, { tier: 'basic' }), 201);
  expect(await api('Admin', 'POST', '/commission-rules', { scope: 'category', scopeValue: 'writing', serviceType: 'freelance', percentage: 25 }), 201);
  const quote = expect(await api('Student', 'GET', `/manual-payments/quote/freelance_milestone/${order.milestones[0]._id}`), 200);
  assert.equal(quote.price, 1250);
});

test('an outsider can only read; nothing private is open', async () => {
  for (const [method, path] of [['GET', '/freelance/orders'], ['GET', '/freelance/earnings'], ['GET', '/freelance/profile/me'], ['GET', '/freelance/my/services'], ['GET', '/freelance/proposals/sent'], ['GET', '/freelance/proposals/received'], ['POST', '/freelance/services'], ['GET', '/freelance/admin/overview'], ['GET', '/receipts/mine'], ['GET', '/commission-rules']]) expect(await api(null, method, path, method === 'POST' ? {} : undefined), 401, path);
  const list = expect(await api(null, 'GET', '/freelance/services?q[$ne]=1&category[]=x&page=-5'), 200, 'odd query');
  assert.ok(Array.isArray(list.items));
  assert.ok(expect(await api(null, 'GET', '/freelance/services?q=(((' ), 200).items);
  const raw = JSON.stringify(expect(await api(null, 'GET', '/freelance/services'), 200));
  assert.ok(!/email|phone|passwordHash/.test(raw), 'no private details in the catalogue');
});

test('the wrong account and bad input are refused; extra fields are ignored', async () => {
  const s = expect(await api('Employer', 'POST', '/freelance/services', service({ title: 'Careers advice session', category: 'career_counselling' })), 201);
  for (const who of ['Student', 'Teacher']) {
    expect(await api(who, 'PATCH', `/freelance/services/${s._id}`, { title: 'Stolen service' }), 404);
    expect(await api(who, 'POST', `/freelance/services/${s._id}/status`, { status: 'paused' }), 404);
  }
  const forced = expect(await api('Teacher', 'POST', '/freelance/services', service({ title: 'Science tuition sessions', status: 'removed', seller: String(u.Student._id), startingAt: 1 })), 201);
  assert.equal(forced.status, 'active');
  assert.equal(String(forced.seller), String(u.Teacher._id));
  assert.equal(forced.startingAt, 1000);
  for (const packages of [[{ tier: 'basic', price: -5, deliveryDays: 3 }], [{ tier: 'basic', price: 10, deliveryDays: 0 }], [{ tier: 'gold', price: 10, deliveryDays: 3 }], [{ tier: 'basic', price: 10, deliveryDays: 2 }, { tier: 'basic', price: 20, deliveryDays: 2 }], [{ tier: 'basic', price: { $gt: 0 }, deliveryDays: 3 }]]) expect(await api('Teacher', 'POST', '/freelance/services', service({ packages })), 422, JSON.stringify(packages));
  expect(await api('Teacher', 'POST', '/freelance/services', service({ image: 'javascript:alert(1)' })), 422);
  expect(await api('Student', 'POST', `/freelance/services/${s._id}/order`, { tier: { $ne: 'x' } }), 422);
  expect(await api('Student', 'POST', '/freelance/services/not-an-id/order', { tier: 'basic' }), 404);
  expect(await api('Student', 'POST', `/freelance/services/${s._id}/status`, { status: 'removed' }), 404);
  const order = expect(await api('Student', 'POST', `/freelance/services/${s._id}/order`, { tier: 'basic' }), 201);
  const m = order.milestones[0]._id;
  expect(await api('Teacher', 'GET', `/manual-payments/quote/freelance_milestone/${m}`), 404, 'only the client pays');
  expect(await api('Student', 'GET', '/manual-payments/quote/freelance_milestone/nope'), 404);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/messages`, { text: '   ' }), 422);
  const quote = expect(await api('Student', 'GET', `/manual-payments/quote/freelance_milestone/${m}`), 200);
  const file = { name: 'r.png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
  const paidOn = new Date().toISOString().slice(0, 10);
  expect(await api('Student', 'POST', `/manual-payments/freelance_milestone/${m}`, { phone: '03001234567', commission: { amount: 1, transactionId: 'WRONGAMOUNT1', paidOn, file } }), 422, 'wrong amount');
  const mp = expect(await api('Student', 'POST', `/manual-payments/freelance_milestone/${m}`, { phone: '03001234567', commission: { amount: quote.commission, transactionId: 'REJECTME0001', paidOn, file } }), 201);
  expect(await api('Student', 'POST', `/freelance/orders/${order._id}/cancel`), 409, 'a payment is being checked');
  expect(await api('Student', 'PATCH', `/manual-payments/${mp._id}/decide`, { decision: 'approve' }), 403, 'cannot approve your own payment');
  expect(await api('Admin', 'PATCH', `/manual-payments/${mp._id}/decide`, { decision: 'reject', note: 'No money arrived' }), 200);
  let view = expect(await api('Student', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.milestones[0].status, 'pending', 'a rejected payment holds nothing');
  await fund('Student', m);
  expect(await api('Student', 'POST', `/manual-payments/freelance_milestone/${m}`, { phone: '03001234567', commission: { amount: quote.commission, transactionId: 'SECONDPAY001', paidOn, file } }), 409, 'cannot pay twice');
  view = expect(await api('Employer', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.milestones[0].status, 'funded');
  assert.equal(view.role, 'freelancer');
  const d = expect(await api('Student', 'POST', `/freelance/orders/${order._id}/milestones/${m}/dispute`, { reason: 'Nothing has been delivered yet', evidence: [{ name: 'chat.png', url: 'https://f.test/chat.png' }] }), 201);
  expect(await api('Employer', 'POST', `/freelance/orders/${order._id}/milestones/${m}/dispute`, { reason: 'A second dispute on the same work' }), 409);
  await model('FreelanceOrder').updateOne({ _id: order._id, 'milestones._id': m }, { $set: { 'milestones.$.note': 'Delivered files', 'milestones.$.submittedAt': new Date(Date.now() - 30 * 864e5) } });
  expect(await api('Employer', 'GET', `/freelance/orders/${order._id}`), 200);
  view = expect(await api('Student', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.milestones[0].status, 'disputed', 'a dispute stops the automatic payment');
  assert.equal(view.disputes[0].evidence[0].name, 'chat.png');
  const overview = expect(await api('Admin', 'GET', '/freelance/admin/overview'), 200);
  const row = overview.disputes.find((x) => x._id === d._id);
  assert.equal(row.milestoneRow.note, 'Delivered files', 'the admin sees the delivery');
  assert.ok(overview.totals[0].held >= 1000);
  assert.ok(overview.totals[0].fees > 0);
  expect(await api('Admin', 'POST', `/freelance/admin/disputes/${d._id}`, { decision: 'refund', note: 'Nothing arrived' }), 200);
  view = expect(await api('Student', 'GET', `/freelance/orders/${order._id}`), 200);
  assert.equal(view.disputes[0].resolution.note, 'Nothing arrived', 'both sides see the decision');
});

test('a suspended seller leaves the catalogue; filters, sorting and the public profile work', async () => {
  const seller = u.Student;
  const s = expect(await api('Student', 'POST', '/freelance/services', service({ title: 'Urdu translation of papers', category: 'translation', packages: [{ tier: 'basic', price: 300, deliveryDays: 2, revisions: 0 }] })), 201);
  expect(await api(null, 'GET', `/freelance/freelancers/${seller._id}`), 200);
  const cheap = expect(await api(null, 'GET', '/freelance/services?maxPrice=500'), 200);
  assert.ok(cheap.items.every((x) => x.startingAt <= 500) && cheap.items.some((x) => x._id === s._id));
  const dear = expect(await api(null, 'GET', '/freelance/services?minPrice=500&sort=price_low'), 200);
  assert.ok(dear.items.every((x) => x.startingAt >= 500));
  const sorted = expect(await api(null, 'GET', '/freelance/services?sort=price_low'), 200);
  assert.equal(sorted.items[0].startingAt, Math.min(...sorted.items.map((x) => x.startingAt)));
  await model('User').updateOne({ _id: seller._id }, { status: 'suspended' });
  expect(await api(null, 'GET', `/freelance/services/${s._id}`), 404);
  assert.ok(!expect(await api(null, 'GET', '/freelance/services'), 200).items.some((x) => x._id === s._id));
  expect(await api(null, 'GET', `/freelance/freelancers/${seller._id}`), 404);
  expect(await api('Teacher', 'POST', `/freelance/services/${s._id}/order`, { tier: 'basic' }), 404);
  await model('User').updateOne({ _id: seller._id }, { status: 'active' });
  assert.ok(expect(await api(null, 'GET', '/freelance/services'), 200).items.some((x) => x._id === s._id));
});

test('the Super Admin can turn the whole hub off', async () => {
  expect(await api('Admin', 'PATCH', '/plugins/admin/modules/freelance', { enabled: false }), 200);
  assert.equal((await api(null, 'GET', '/freelance/services')).status, 503);
  expect(await api('Admin', 'PATCH', '/plugins/admin/modules/freelance', { enabled: true }), 200);
  assert.equal((await api(null, 'GET', '/freelance/services')).status, 200);
});
