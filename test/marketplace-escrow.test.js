const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { PDFDocument } = require('pdf-lib');

// Master 16B: escrow with triple verification, delivery OTP, digital rights (preview, stamped
// copy, online-only), disputes with evidence, and the seller trust score.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: json, text, buf, type: res.headers.get('content-type') || '' };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@escrow.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount) => ({ amount, transactionId: `TXN${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'r.png', data: PNG } });

async function buyAndPay(product, qty = 1) {
  const o = await api('Buyer', 'POST', `/marketplace/products/${product}/orders`, { quantity: qty, shipping: { name: 'Test Buyer', phone: '03001234567', cnic: '35202-1234567-1', address: 'House 1, Street 2, Model Town', city: 'Lahore' } });
  expect(o, 201, 'order');
  const q = await api('Buyer', 'GET', `/manual-payments/quote/marketplace_order/${o.body.data._id}`);
  expect(q, 200, 'quote');
  assert.equal(q.body.data.sellerAmount, 0, 'nothing goes straight to the seller');
  const p = await api('Buyer', 'POST', `/manual-payments/marketplace_order/${o.body.data._id}`, { phone: '03001234567', commission: leg(q.body.data.commission) });
  expect(p, 201, 'pay');
  expect(await api('Boss', 'PATCH', `/manual-payments/${p.body.data._id}/decide`, { decision: 'approve' }), 200, 'approve');
  return { id: o.body.data._id, total: q.body.data.commission };
}
const myOrder = async (id) => (await api('Buyer', 'GET', '/marketplace/orders/mine')).body.data.find((x) => x._id === id);

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Seller', 'marketplace_seller');
  await account('Buyer', 'student');
  await account('Boss', 'super_admin');
  await model('Setting').create({ key: 'marketplace_commission_percent', value: 10 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  expect(await api('Boss', 'PUT', '/manual-payments/platform-account', { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819', qr: PNG }), 200);
  S.book = (await model('Product').create({ seller: u.Seller._id, title: 'Physics book', price: 1000, currency: 'PKR', category: 'books', stock: 10, status: 'active' }))._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('escrow + delivery OTP: CareerZ holds the money; the seller gets it only with the buyer\'s code', async () => {
  const { id, total } = await buyAndPay(S.book);
  assert.equal(total, 1100, 'price plus the 10% CareerZ fee, all to CareerZ');
  const o = await myOrder(id);
  assert.equal(o.escrow.status, 'held');
  assert.match(o.deliveryCode, /^\d{6}$/, 'the buyer sees the delivery code');
  const sellerView = (await api('Seller', 'GET', '/marketplace/orders/selling')).body.data.find((x) => x._id === id);
  assert.equal(sellerView.deliveryCode, undefined, 'the seller never sees the code');
  let earn = (await api('Seller', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR;
  assert.equal(earn.availableEarnings, 0, 'nothing to withdraw while held');
  expect(await api('Seller', 'PATCH', `/marketplace/orders/${id}/status`, { status: 'completed' }), 403, 'seller cannot complete it');
  expect(await api('Seller', 'POST', `/marketplace/orders/${id}/deliver`, { code: '000000' }), 422, 'wrong code');
  expect(await api('Seller', 'POST', `/marketplace/orders/${id}/deliver`, { code: o.deliveryCode }), 200);
  const done = await myOrder(id);
  assert.equal(done.escrow.status, 'released');
  assert.equal(done.escrow.releasedBy, 'otp');
  earn = (await api('Seller', 'GET', '/marketplace/sellers/mine/earnings')).body.data.totalsByCurrency.PKR;
  assert.equal(earn.availableEarnings, 1000, 'the full price is now withdrawable');
});

test('release by "Confirm received", and automatically 7 days after delivery when nobody objects', async () => {
  const a = await buyAndPay(S.book);
  expect(await api('Buyer', 'POST', `/marketplace/orders/${a.id}/confirm-received`), 200);
  assert.equal((await myOrder(a.id)).escrow.releasedBy, 'buyer');
  const b = await buyAndPay(S.book);
  expect(await api('Seller', 'PATCH', `/marketplace/orders/${b.id}/status`, { status: 'delivered' }), 200, 'delivered without a code');
  assert.equal((await myOrder(b.id)).escrow.status, 'held', 'still held');
  await model('Order').updateOne({ _id: b.id }, { $set: { deliveredAt: new Date(Date.now() - 8 * 864e5) } });
  const auto = await myOrder(b.id);
  assert.equal(auto.escrow.status, 'released');
  assert.equal(auto.escrow.releasedBy, 'auto');
});

test('dispute with evidence freezes the money; admin refunds the buyer and records the transfer', async () => {
  const { id } = await buyAndPay(S.book);
  expect(await api('Buyer', 'POST', `/marketplace/orders/${id}/dispute`, { reason: 'short' }), 422);
  expect(await api('Buyer', 'POST', `/marketplace/orders/${id}/dispute`, { reason: 'The book arrived torn and two chapters are missing.', note: 'Photo attached', file: { name: 'torn.png', data: PNG } }), 200);
  expect(await api('Buyer', 'POST', `/marketplace/orders/${id}/confirm-received`), 409, 'frozen');
  expect(await api('Seller', 'POST', `/marketplace/orders/${id}/dispute/evidence`, { note: 'It left our shop in good condition; courier slip attached.' }), 200);
  expect(await api('Seller', 'GET', `/marketplace/orders/${id}/dispute/evidence/0`), 200, 'both sides can open the evidence');
  const queue = await api('Boss', 'GET', '/marketplace/admin/escrow');
  assert.ok(queue.body.data.rows.some((r) => r._id === id && r.escrow.status === 'disputed'));
  expect(await api('Boss', 'PATCH', `/marketplace/admin/orders/${id}/dispute`, { decision: 'refund', note: 'Photos show the damage.' }), 200);
  assert.equal((await myOrder(id)).escrow.status, 'refund_due');
  expect(await api('Boss', 'PATCH', `/marketplace/admin/orders/${id}/refunded`, { reference: 'IBFT998877' }), 200);
  const r = await myOrder(id);
  assert.equal(r.escrow.status, 'refunded');
  assert.equal(r.status, 'refunded');
});

test('digital product: stamped preview, file only after paying, online-only respected, auto-release after use', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i++) doc.addPage().drawText(`Page ${i + 1}`, { x: 50, y: 700 });
  const pdf = `data:application/pdf;base64,${Buffer.from(await doc.save()).toString('base64')}`;
  const c = await api('Seller', 'POST', '/marketplace/products', { title: 'Chemistry notes', category: 'notes', price: 500, currency: 'PKR', digitalFile: { name: 'chem.pdf', data: pdf }, digitalAccess: 'online' });
  expect(c, 201);
  S.notes = c.body.data._id;
  assert.equal(c.body.data.digital.pages, 6);
  await model('Product').updateOne({ _id: S.notes }, { $set: { status: 'active' } });
  const pub = await api(null, 'GET', `/public/marketplace/${S.notes}`);
  assert.equal(pub.body.data.digital.pages, 6);
  const prev = await api(null, 'GET', `/marketplace/products/${S.notes}/preview`);
  expect(prev, 200);
  assert.equal((await PDFDocument.load(prev.buf)).getPageCount(), 4, 'three pages plus the "preview ends" page');
  const { id } = await buyAndPay(S.notes);
  expect(await api('Buyer', 'GET', `/marketplace/orders/${id}/file?mode=download`), 403, 'online only');
  const view = await api('Buyer', 'GET', `/marketplace/orders/${id}/file?mode=view`);
  expect(view, 200);
  assert.equal((await PDFDocument.load(view.buf)).getPageCount(), 6, 'the whole file');
  assert.ok(view.type.includes('pdf'));
  expect(await api('Seller', 'GET', `/marketplace/orders/${id}/file`), 404, 'only the buyer');
  await model('Order').updateOne({ _id: id }, { $set: { 'accessLog.0.at': new Date(Date.now() - 4 * 864e5) } });
  assert.equal((await myOrder(id)).escrow.releasedBy, 'auto', 'released 3 days after the buyer opened it');
});

test('seller trust score from rating, delivery, complaints and refunds; a cancelled paid order becomes a refund', async () => {
  const { id } = await buyAndPay(S.book);
  expect(await api('Seller', 'PATCH', `/marketplace/orders/${id}/status`, { status: 'cancelled' }), 200);
  assert.equal((await myOrder(id)).escrow.status, 'refund_due');
  const t = await api(null, 'GET', `/marketplace/sellers/${u.Seller._id}/trust`);
  expect(t, 200);
  const f = Object.fromEntries(t.body.data.factors.map((x) => [x.key, x]));
  assert.ok(f.complaints.hasData);
  assert.ok(t.body.data.score > 0 && t.body.data.score < 100);
  assert.ok(f.delivery.points > 0);
});
