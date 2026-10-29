const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Marketplace end to end, from every side: an outsider (quick checkout), a student buyer, a
// student seller, a marketplace seller and the admin. Receiver details, payment into escrow,
// shipping with tracking, delivery code, timeline, notifications, cancellations with stock
// back, unpaid orders expiring, reviews (product + seller), trust score and payout account.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
const mails = [];
mock.method(emailService, 'sendEmail', async (m) => { mails.push(m); return { ok: true }; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {}, T = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (T[who]) headers.Authorization = `Bearer ${T[who]}`;
  else if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@e2e.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount) => ({ amount, transactionId: `TXN${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'r.png', data: PNG } });
const SHIP = { name: 'Ayesha Malik', phone: '03214567890', cnic: '3520212345671', address: 'House 12, Street 5, Gulberg III', city: 'Lahore', province: 'Punjab', landmark: 'Near Liberty Market', locationUrl: 'https://maps.google.com/?q=31.5,74.3' };
async function pay(who, orderId) {
  const q = await api(who, 'GET', `/manual-payments/quote/marketplace_order/${orderId}`);
  expect(q, 200, 'quote');
  const p = await api(who, 'POST', `/manual-payments/marketplace_order/${orderId}`, { phone: '03214567890', commission: leg(q.body.data.commission) });
  expect(p, 201, 'pay');
  expect(await api('Admin', 'PATCH', `/manual-payments/${p.body.data._id}/decide`, { decision: 'approve' }), 200, 'admin approves');
}
const stock = async (id) => (await model('Product').findById(id).lean()).stock;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Shop', 'marketplace_seller');
  await account('Stud', 'student');
  await account('StudSeller', 'student');
  await account('Admin', 'super_admin');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  expect(await api('Admin', 'PUT', '/manual-payments/platform-account', { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819', qr: PNG }), 200);
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('1. verified sellers publish at once; the automatic check holds only suspicious listings for an admin', async () => {
  const book = await api('Shop', 'POST', '/marketplace/products', { title: 'Matric Biology book', category: 'books', price: 800, currency: 'PKR', stock: 3, description: 'New, sealed.' });
  expect(book, 201);
  S.book = book.body.data._id;
  const uni = await api('StudSeller', 'POST', '/marketplace/products', { title: 'School uniform size M', category: 'uniform', price: 1200, currency: 'PKR', stock: 1 });
  expect(uni, 201, 'a student sells too');
  S.uniform = uni.body.data._id;
  assert.equal(book.body.data.status, 'active', 'live at once');
  assert.equal(uni.body.data.status, 'active');
  const pub = await api(null, 'GET', '/public/marketplace');
  assert.equal(pub.body.data.items.length, 2, 'both public without an admin');
  const bad = await api('Shop', 'POST', '/marketplace/products', { title: 'Fake degree certificate', category: 'other', price: 5000, stock: 1, description: 'Any university, call 0300 1234567' });
  expect(bad, 201);
  assert.equal(bad.body.data.status, 'pending_approval', 'held by the automatic check');
  assert.ok(bad.body.data.moderation.flags.some((f) => f.code === 'banned_item'));
  const queue = await api('Admin', 'GET', '/marketplace/products/admin/pending');
  assert.equal(queue.body.data.length, 1, 'only the suspicious listing waits');
  expect(await api('Stud', 'PATCH', `/marketplace/products/${bad.body.data._id}/moderate`, { status: 'active' }), 403, 'only admins decide');
  expect(await api('Admin', 'PATCH', `/marketplace/products/${bad.body.data._id}/moderate`, { status: 'rejected', reviewNotes: 'Fake documents are not allowed.' }), 200);
  assert.ok(!(await api(null, 'GET', '/public/marketplace')).body.data.items.some((p) => p._id === bad.body.data._id));
  const detail = await api(null, 'GET', `/public/marketplace/${S.book}`);
  assert.equal(String(detail.body.data.sellerId), String(u.Shop._id), 'product page knows its seller for the trust card');
  const payoutNeeded = await api('StudSeller', 'GET', '/wallet/payout-account');
  assert.equal(payoutNeeded.body.data.needed, true, 'a student who sells is reminded to add a payout account');
});

test('2. outsider: quick checkout, receiver details are required and checked, saved for next time', async () => {
  mails.length = 0;
  expect(await api(null, 'POST', '/marketplace/quick-checkout/start', { name: 'Ayesha Malik', email: 'ayesha@outside.test', phone: '03214567890' }), 200);
  const code = (mails.find((m) => m.to === 'ayesha@outside.test')?.text || '').match(/\b\d{6}\b/)?.[0];
  const v = await api(null, 'POST', '/marketplace/quick-checkout/verify', { email: 'ayesha@outside.test', code });
  expect(v, 200);
  T.Guest = v.body.data.accessToken;
  expect(await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1 }), 422, 'no address, no parcel');
  expect(await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: { ...SHIP, cnic: '123' } }), 422, 'bad CNIC');
  expect(await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: { ...SHIP, phone: 'abc' } }), 422, 'bad phone');
  expect(await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: { ...SHIP, locationUrl: 'javascript:x' } }), 422, 'location must be https');
  expect(await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 9, shipping: SHIP }), 400, 'more than in stock');
  const o = await api('Guest', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: SHIP, note: 'Please call before coming' });
  expect(o, 201);
  S.guestOrder = o.body.data._id;
  assert.equal(o.body.data.shipping.cnic, '35202-1234567-1', 'CNIC formatted');
  assert.equal(o.body.data.timeline[0].status, 'pending');
  assert.equal(await stock(S.book), 2, 'stock reserved');
  const saved = await api('Guest', 'GET', '/marketplace/me/shipping');
  assert.equal(saved.body.data.address, SHIP.address, 'details offered again next time');
});

test('3. payment goes to CareerZ (escrow); the seller gets every receiver detail; nothing ships before payment', async () => {
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'shipped', courier: 'TCS', trackingNo: '123456' }), 409, 'not paid yet');
  await pay('Guest', S.guestOrder);
  const seen = (await api('Shop', 'GET', '/marketplace/orders/selling')).body.data.find((o) => o._id === S.guestOrder);
  assert.deepEqual([seen.shipping.name, seen.shipping.phone, seen.shipping.cnic, seen.shipping.city, seen.shipping.landmark], ['Ayesha Malik', '03214567890', '35202-1234567-1', 'Lahore', 'Near Liberty Market']);
  assert.ok(seen.shipping.locationUrl.startsWith('https://'));
  assert.equal(seen.note, 'Please call before coming');
  assert.equal(seen.escrow.status, 'held');
  assert.equal(seen.deliveryCode, undefined, 'the seller never sees the delivery code');
  expect(await api('Stud', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'shipped' }), 403, 'only the seller');
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'confirmed' }), 200);
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'shipped' }), 422, 'courier needed');
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'shipped', courier: 'TCS' }), 422, 'tracking number needed');
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.guestOrder}/status`, { status: 'shipped', courier: 'TCS', trackingNo: 'TCS-778899', trackingUrl: 'https://www.tcsexpress.com/track/TCS-778899' }), 200);
});

test('4. tracking: the buyer sees each step with times and the courier number, and is told each time', async () => {
  const mine = (await api('Guest', 'GET', '/marketplace/orders/mine')).body.data.find((o) => o._id === S.guestOrder);
  assert.deepEqual(mine.timeline.map((s) => s.status), ['pending', 'paid', 'confirmed', 'shipped']);
  assert.equal(mine.shipment.courier, 'TCS');
  assert.equal(mine.shipment.trackingNo, 'TCS-778899');
  assert.match(mine.deliveryCode, /^\d{6}$/);
  const notes = await model('Notification').find({ user: mine.buyer }).lean();
  assert.ok(notes.some((n) => /Parcel shipped/.test(n.title)), 'told the parcel shipped');
  assert.ok(notes.some((n) => /delivery code/.test(n.title)), 'got the delivery code');
  expect(await api('Guest', 'POST', `/marketplace/orders/${S.guestOrder}/review`, { rating: 5 }), 400, 'no rating before delivery');
  S.code = mine.deliveryCode;
});

test('5. delivery with the code releases the money; rating the product and the seller; public reviews', async () => {
  expect(await api('Shop', 'POST', `/marketplace/orders/${S.guestOrder}/deliver`, { code: S.code }), 200);
  const done = (await api('Guest', 'GET', '/marketplace/orders/mine')).body.data.find((o) => o._id === S.guestOrder);
  assert.equal(done.status, 'completed');
  assert.equal(done.timeline.at(-1).status, 'completed');
  assert.equal(done.reviewed, false);
  expect(await api('Stud', 'POST', `/marketplace/orders/${S.guestOrder}/review`, { rating: 5 }), 403, 'only the buyer');
  expect(await api('Guest', 'POST', `/marketplace/orders/${S.guestOrder}/review`, { rating: 6 }), 422);
  expect(await api('Guest', 'POST', `/marketplace/orders/${S.guestOrder}/review`, { rating: 5, sellerRating: 4, comment: 'Book as described, fast delivery.' }), 201, 'outsider rates after delivery');
  expect(await api('Guest', 'POST', `/marketplace/orders/${S.guestOrder}/review`, { rating: 5 }), 409, 'once per order');
  const pub = await api(null, 'GET', `/marketplace/products/${S.book}/reviews`);
  assert.equal(pub.body.data[0].buyer.fullName, 'Ayesha', 'first name only');
  assert.equal(pub.body.data[0].sellerRating, 4);
  assert.equal(pub.body.data[0].verified, true);
  const trust = await api(null, 'GET', `/marketplace/sellers/${u.Shop._id}/trust`);
  assert.equal(trust.body.data.rating, 4, 'trust uses the seller rating');
  const earn = (await api('Shop', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR;
  assert.equal(earn.availableEarnings, 800);
});

test('6. student buyer: cancellation gives stock back; a paid cancellation becomes a CareerZ refund', async () => {
  const before = await stock(S.uniform);
  const o = await api('Stud', 'POST', `/marketplace/products/${S.uniform}/orders`, { quantity: 1, shipping: SHIP });
  expect(o, 201);
  assert.equal(await stock(S.uniform), before - 1);
  assert.equal((await model('Product').findById(S.uniform).lean()).status, 'out_of_stock');
  await pay('Stud', o.body.data._id);
  expect(await api('Stud', 'POST', `/marketplace/orders/${o.body.data._id}/request-cancellation`, { reason: 'Wrong size' }), 200);
  expect(await api('StudSeller', 'PATCH', `/marketplace/orders/${o.body.data._id}/cancellation-response`, { approve: true }), 200);
  const after = await model('Order').findById(o.body.data._id).lean();
  assert.equal(after.status, 'cancelled');
  assert.equal(after.escrow.status, 'refund_due', 'CareerZ refunds the paid amount');
  assert.equal(await stock(S.uniform), before, 'stock back');
  assert.equal((await model('Product').findById(S.uniform).lean()).status, 'active', 'listing live again');
  expect(await api('StudSeller', 'PATCH', `/marketplace/orders/${o.body.data._id}/status`, { status: 'processing' }), 409, 'a cancelled order cannot move again');
});

test('7. an order not paid within 3 days is cancelled and its stock freed', async () => {
  const o = await api('Stud', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 2, shipping: SHIP });
  expect(o, 201);
  assert.equal(await stock(S.book), 0);
  await model('Order').collection.updateOne({ _id: new mongoose.Types.ObjectId(o.body.data._id) }, { $set: { createdAt: new Date(Date.now() - 4 * 864e5) } });
  const mine = (await api('Stud', 'GET', '/marketplace/orders/mine')).body.data.find((x) => x._id === o.body.data._id);
  assert.equal(mine.status, 'cancelled');
  assert.equal(await stock(S.book), 2);
});

test('8. own delivery without a courier, buyer confirms; admin escrow desk lists what is held', async () => {
  const o = await api('Stud', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: SHIP });
  await pay('Stud', o.body.data._id);
  const desk = await api('Admin', 'GET', '/marketplace/admin/escrow');
  assert.ok(desk.body.data.rows.some((r) => r._id === o.body.data._id && r.escrow.status === 'held'));
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${o.body.data._id}/status`, { status: 'shipped', courier: 'Own delivery' }), 200, 'own delivery needs no tracking number');
  expect(await api('Stud', 'POST', `/marketplace/orders/${o.body.data._id}/confirm-received`), 200);
  expect(await api('Stud', 'POST', `/marketplace/orders/${o.body.data._id}/review`, { rating: 3, comment: 'OK' }), 201, 'rating works after release (completed)');
});

test('9. buyer changes quantity before paying, updates delivery details, cancels directly', async () => {
  await model('Product').updateOne({ _id: S.book }, { $set: { stock: 10, status: 'active' } });
  const start = await stock(S.book);
  const o = await api('Stud', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: SHIP });
  const id = o.body.data._id;
  expect(await api('Stud', 'PATCH', `/marketplace/orders/${id}/quantity`, { quantity: 99 }), 400, 'more than in stock');
  const q = await api('Stud', 'PATCH', `/marketplace/orders/${id}/quantity`, { quantity: 2 });
  expect(q, 200);
  assert.equal(q.body.data.totalPrice, 1600);
  assert.equal(await stock(S.book), start - 2);
  expect(await api('Guest', 'PATCH', `/marketplace/orders/${id}/quantity`, { quantity: 1 }), 404, 'not your order');
  expect(await api('Stud', 'PATCH', `/marketplace/orders/${id}/shipping`, { shipping: { ...SHIP, address: 'Flat 4, Block C, DHA Phase 5', city: 'Karachi' } }), 200);
  assert.equal((await model('Order').findById(id).lean()).shipping.city, 'Karachi');
  expect(await api('Stud', 'POST', `/marketplace/orders/${id}/cancel`, { reason: 'Bought elsewhere' }), 200, 'unpaid: cancel at once');
  assert.equal(await stock(S.book), start, 'stock back');
  // Paid but not packed: cancel at once, CareerZ refunds. After packing: must ask the seller.
  const p = await api('Stud', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: SHIP });
  await pay('Stud', p.body.data._id);
  expect(await api('Stud', 'PATCH', `/marketplace/orders/${p.body.data._id}/quantity`, { quantity: 2 }), 409, 'quantity fixed once paid');
  expect(await api('Stud', 'POST', `/marketplace/orders/${p.body.data._id}/cancel`), 200);
  assert.equal((await model('Order').findById(p.body.data._id).lean()).escrow.status, 'refund_due');
  const r = await api('Stud', 'POST', `/marketplace/products/${S.book}/orders`, { quantity: 1, shipping: SHIP });
  await pay('Stud', r.body.data._id);
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${r.body.data._id}/status`, { status: 'processing' }), 200);
  expect(await api('Stud', 'POST', `/marketplace/orders/${r.body.data._id}/cancel`), 409, 'packing started: ask the seller');
  expect(await api('Stud', 'POST', `/marketplace/orders/${r.body.data._id}/request-cancellation`, { reason: 'Changed mind' }), 200);
  S.processing = r.body.data._id;
});

test('10. seller edits a listing (checked again automatically), cannot delete it with an order in progress, removes it later keeping history', async () => {
  expect(await api('Shop', 'PATCH', `/marketplace/products/${S.book}`, { price: 900 }), 200, 'price change stays live');
  assert.equal((await model('Product').findById(S.book).lean()).status, 'active');
  expect(await api('Shop', 'PATCH', `/marketplace/products/${S.book}`, { title: 'Matric Biology book (2026 edition)' }), 200);
  assert.equal((await model('Product').findById(S.book).lean()).status, 'active', 'a clean edit stays live');
  expect(await api('Shop', 'PATCH', `/marketplace/products/${S.book}`, { description: 'Pay advance payment to my JazzCash 0300 1234567 before ordering' }), 200);
  assert.equal((await model('Product').findById(S.book).lean()).status, 'pending_approval', 'a suspicious edit is held');
  expect(await api('Admin', 'PATCH', `/marketplace/products/${S.book}/moderate`, { status: 'active' }), 200);
  expect(await api('Stud', 'DELETE', `/marketplace/products/${S.book}`), 404, 'not the owner');
  expect(await api('Shop', 'DELETE', `/marketplace/products/${S.book}`), 409, 'an order is in progress');
  expect(await api('Shop', 'PATCH', `/marketplace/orders/${S.processing}/cancellation-response`, { approve: true }), 200);
  expect(await api('Shop', 'DELETE', `/marketplace/products/${S.book}`), 200);
  assert.equal((await model('Product').findById(S.book).lean()).status, 'removed', 'kept for history');
  assert.ok(!(await api('Shop', 'GET', '/marketplace/products/mine/list')).body.data.some((p) => p._id === S.book), 'gone from my listings');
  assert.ok(!(await api(null, 'GET', '/public/marketplace')).body.data.items.some((p) => p._id === S.book), 'gone from the marketplace');
  const history = (await api('Guest', 'GET', '/marketplace/orders/mine')).body.data.find((o) => o._id === S.guestOrder);
  assert.equal(history.product.title, 'Matric Biology book (2026 edition)', 'old orders still show the item');
  const fresh = await api('Shop', 'POST', '/marketplace/products', { title: 'Unsold pen set', category: 'stationery', price: 100, stock: 2 });
  expect(await api('Shop', 'DELETE', `/marketplace/products/${fresh.body.data._id}`), 200);
  assert.equal(await model('Product').exists({ _id: fresh.body.data._id }), null, 'never ordered: deleted for good');
});

test('11. seller report: best seller, units, revenue, cancellations, ratings and 12 months', async () => {
  const r = await api('Shop', 'GET', '/marketplace/sellers/mine/report');
  expect(r, 200);
  const d = r.body.data;
  assert.equal(d.bestSeller.title, 'Matric Biology book (2026 edition)');
  assert.ok(d.totals.unitsSold >= 2);
  assert.ok(d.totals.revenue >= 1600);
  assert.ok(d.totals.cancelled >= 3);
  assert.equal(d.months.length, 12);
  assert.ok(d.months.at(-1).revenue > 0);
  const row = d.products.find((p) => p.title.startsWith('Matric'));
  assert.equal(row.rating, 4, 'average of the product ratings');
  expect(await api('Stud', 'GET', '/marketplace/sellers/mine/report'), 200, 'a student seller has a report too');
  expect(await api('Guest', 'GET', '/marketplace/sellers/mine/report'), 403, 'not a seller');
});

test('12. a buyer cancels: the seller is told who and why, and they talk on the order thread', async () => {
  await model('Product').updateOne({ _id: S.uniform }, { $set: { stock: 4, status: 'active' } });
  const o = await api('Guest', 'POST', `/marketplace/products/${S.uniform}/orders`, { quantity: 1, shipping: SHIP });
  expect(o, 201);
  assert.equal(await stock(S.uniform), 3, '4 in stock, 1 ordered: 3 left');
  expect(await api('Guest', 'POST', `/marketplace/orders/${o.body.data._id}/cancel`, { reason: 'Found it cheaper' }), 200);
  assert.equal(await stock(S.uniform), 4, 'cancelled: back to 4');
  const note = await model('Notification').findOne({ user: u.StudSeller._id, title: /cancelled by the buyer/ }).lean();
  assert.ok(note && /Found it cheaper/.test(note.body), 'the seller is told the reason');
  expect(await api('StudSeller', 'POST', `/marketplace/orders/${o.body.data._id}/messages`, { text: 'Sorry to see you go. Can I offer a discount?' }), 200);
  expect(await api('Guest', 'POST', `/marketplace/orders/${o.body.data._id}/messages`, { text: 'Yes, 10% off and I will order again.' }), 200);
  const t = await api('Guest', 'GET', `/marketplace/orders/${o.body.data._id}/messages`);
  assert.deepEqual(t.body.data.messages.map((m) => m.from), ['seller', 'buyer']);
  expect(await api('Stud', 'GET', `/marketplace/orders/${o.body.data._id}/messages`), 404, 'others cannot read it');
  const seen = (await api('StudSeller', 'GET', '/marketplace/orders/selling')).body.data.find((x) => x._id === o.body.data._id);
  assert.equal(seen.status, 'cancelled');
  assert.equal(seen.timeline.at(-1).note, 'Found it cheaper', 'the reason is on the order too');
  // Every kind of step is tracked: dispute, decision and refund too.
  const d = await api('Stud', 'POST', `/marketplace/products/${S.uniform}/orders`, { quantity: 1, shipping: SHIP });
  await pay('Stud', d.body.data._id);
  expect(await api('Stud', 'POST', `/marketplace/orders/${d.body.data._id}/dispute`, { reason: 'Seller never replies and nothing was sent.' }), 200);
  expect(await api('Admin', 'PATCH', `/marketplace/admin/orders/${d.body.data._id}/dispute`, { decision: 'refund', note: 'Nothing shipped.' }), 200);
  expect(await api('Admin', 'PATCH', `/marketplace/admin/orders/${d.body.data._id}/refunded`, { reference: 'IBFT445566' }), 200);
  const steps = (await model('Order').findById(d.body.data._id).lean()).timeline.map((x) => x.status);
  assert.deepEqual(steps, ['pending', 'paid', 'dispute', 'dispute', 'refunded']);
});

test('13. trust score is calculated from real orders: delivery (measured + what buyers said), complaints, refunds and lost disputes', async () => {
  await account('Shop2', 'marketplace_seller');
  const p = await model('Product').create({ seller: u.Shop2._id, title: 'Geometry box', price: 500, currency: 'PKR', category: 'stationery', stock: 20, status: 'active' });
  let t = (await api(null, 'GET', `/marketplace/sellers/${u.Shop2._id}/trust`)).body.data;
  assert.equal(t.score, null, 'a new seller has no score yet');
  assert.equal(t.level, 'New seller');
  const make = async () => { const o = await api('Stud', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1, shipping: SHIP }); await pay('Stud', o.body.data._id); return o.body.data._id; };
  const codeOf = async (id) => (await model('Order').findById(id).select('+deliveryCode').lean()).deliveryCode;
  const a = await make(), b = await make(), c = await make(), d = await make();
  expect(await api('Shop2', 'POST', `/marketplace/orders/${a}/deliver`, { code: await codeOf(a) }), 200);
  expect(await api('Shop2', 'POST', `/marketplace/orders/${b}/deliver`, { code: await codeOf(b) }), 200);
  expect(await api('Stud', 'POST', `/marketplace/orders/${d}/confirm-received`), 200);
  expect(await api('Stud', 'POST', `/marketplace/orders/${a}/review`, { rating: 5, sellerRating: 5, deliveredOnTime: true, asDescribed: true }), 201);
  expect(await api('Stud', 'POST', `/marketplace/orders/${b}/review`, { rating: 3, sellerRating: 3, deliveredOnTime: false, asDescribed: true }), 201);
  expect(await api('Stud', 'POST', `/marketplace/orders/${c}/dispute`, { reason: 'The box never arrived at my address.' }), 200);
  expect(await api('Admin', 'PATCH', `/marketplace/admin/orders/${c}/dispute`, { decision: 'refund', note: 'No proof of shipping.' }), 200);
  expect(await api('Admin', 'PATCH', `/marketplace/admin/orders/${c}/refunded`, { reference: 'IBFT112233' }), 200);
  t = (await api(null, 'GET', `/marketplace/sellers/${u.Shop2._id}/trust`)).body.data;
  const f = Object.fromEntries(t.factors.map((x) => [x.key, x]));
  assert.equal(t.rating, 4, 'seller ratings 5 and 3');
  assert.equal(f.rating.points, 28);
  assert.equal(f.delivery.points, 19, '100% measured on time, 50% of buyers said on time → 75%');
  assert.match(f.delivery.value, /buyers say on time/);
  assert.equal(f.complaints.value, '1 dispute in 4 orders');
  assert.equal(f.complaints.points, 0, '1 in 4 is a high complaint ratio');
  assert.equal(f.refunds.value, '1 refunded, 1 dispute lost');
  assert.equal(t.score, Math.round(100 * (28 + 19 + 0 + 0) / 100));
  const pub = (await api(null, 'GET', `/marketplace/products/${p._id}/reviews`)).body.data;
  assert.ok(pub.some((r) => r.deliveredOnTime === false), 'buyers can see "arrived late"');
});

test('14. a return approved after the seller was paid: CareerZ refunds the buyer and it comes off the seller balance', async () => {
  const p = await model('Product').create({ seller: u.Shop2._id, title: 'Calculator', price: 2000, currency: 'PKR', category: 'electronics', stock: 5, status: 'active' });
  const before = (await api('Shop2', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR.availableEarnings;
  const o = await api('Stud', 'POST', `/marketplace/products/${p._id}/orders`, { quantity: 1, shipping: SHIP });
  await pay('Stud', o.body.data._id);
  expect(await api('Stud', 'POST', `/marketplace/orders/${o.body.data._id}/confirm-received`), 200);
  let now = (await api('Shop2', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR.availableEarnings;
  assert.equal(now, before + 2000);
  expect(await api('Stud', 'POST', `/marketplace/orders/${o.body.data._id}/request-refund`, { reason: 'Stopped working after a day' }), 200);
  expect(await api('Shop2', 'PATCH', `/marketplace/orders/${o.body.data._id}/refund-response`, { approve: true }), 200);
  const row = await model('Order').findById(o.body.data._id).lean();
  assert.equal(row.escrow.status, 'refund_due');
  now = (await api('Shop2', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR.availableEarnings;
  assert.equal(now, before, 'the refunded sale is no longer withdrawable');
  expect(await api('Admin', 'PATCH', `/marketplace/admin/orders/${o.body.data._id}/refunded`, { reference: 'IBFT990011' }), 200);
  const done = (await api('Stud', 'GET', '/marketplace/orders/mine')).body.data.find((x) => x._id === o.body.data._id);
  assert.equal(done.escrow.status, 'refunded');
  assert.equal(done.timeline.at(-1).status, 'refunded');
});
