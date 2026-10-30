const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Super Admin Comments & Ratings Management: every rating in one place, hide / show / edit / delete,
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@mod.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const S = {};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Emp', 'employer');
  await account('Seller', 'marketplace_seller');
  await account('Cand', 'student');
  await model('User').updateOne({ _id: u.Emp._id }, { $set: { phone: '03001112233' } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  S.job = await model('Job').create({ postedBy: u.Emp._id, title: 'Data Entry – earn 200k from home', company: 'Quick Cash', city: 'Lahore', country: 'PK', status: 'active', description: 'Pay registration fee first.' });
  await model('JobApplication').create({ job: S.job._id, applicant: u.Cand._id, status: 'pending' });
  S.product = await model('Product').create({ seller: u.Seller._id, title: 'Matric Physics notes', description: 'Notes', price: 95000, currency: 'PKR', stock: 5, category: 'notes', status: 'active' });
  S.order = await model('Order').create({ product: S.product._id, buyer: u.Cand._id, seller: u.Seller._id, quantity: 1, unitPrice: 95000, totalPrice: 95000, currency: 'PKR', status: 'pending', paymentStatus: 'pending' });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('admin finds listings with the owner\'s phone; only admins', async () => {
  expect(await api('Emp', 'GET', '/admin/moderation/listings?kind=job'), 403);
  const rows = (await api('Boss', 'GET', '/admin/moderation/listings?kind=job&q=cash')).body.data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner.phone, '03001112233');
  assert.equal((await api('Boss', 'GET', '/admin/moderation/listings?kind=product')).body.data[0].price, 95000);
});

test('a removed job disappears, the owner sees why and cannot re-publish, applicants are warned; restore works', async () => {
  expect(await api('Boss', 'POST', `/admin/moderation/job/${S.job._id}/remove`, { reason: '' }), 422, 'reason needed');
  expect(await api('Boss', 'POST', `/admin/moderation/job/${S.job._id}/remove`, { reason: 'Asks candidates for a registration fee (scam).' }), 200);
  expect(await api(null, 'GET', `/public/jobs/${S.job._id}`), 404, 'gone from public');
  const mine = (await model('Job').findById(S.job._id).lean());
  assert.equal(mine.status, 'removed_by_admin');
  assert.match(mine.adminRemoval.reason, /registration fee/);
  const edit = await api('Emp', 'PATCH', `/jobs/${S.job._id}`, { status: 'active' });
  expect(edit, 403, 'owner cannot re-publish');
  assert.match(edit.body.message, /CareerZ admin removed this/);
  assert.ok(await model('Notification').exists({ user: u.Emp._id, title: /removed by CareerZ admin/ }), 'owner told');
  assert.ok(await model('Notification').exists({ user: u.Cand._id, title: /job you applied to was removed/ }), 'applicant warned');
  expect(await api('Boss', 'POST', `/admin/moderation/job/${S.job._id}/restore`), 200);
  assert.equal((await model('Job').findById(S.job._id)).status, 'active');
});

test('an overpriced product is removed: hidden, unpaid orders cancelled, seller cannot re-list it', async () => {
  expect(await api('Boss', 'POST', `/admin/moderation/product/${S.product._id}/remove`, { reason: 'Price far above the market (notes sell for about PKR 1,500).' }), 200);
  expect(await api(null, 'GET', `/public/marketplace/${S.product._id}`), 404);
  assert.equal((await model('Order').findById(S.order._id)).status, 'cancelled');
  expect(await api('Seller', 'PATCH', `/marketplace/products/${S.product._id}`, { price: 90000 }), 403);
  const removed = (await api('Boss', 'GET', '/admin/moderation/listings?kind=product&status=removed')).body.data;
  assert.equal(removed.length, 1);
});

test('full user details: search by phone, roles, profile, documents, activity', async () => {
  const list = (await api('Boss', 'GET', '/admin/moderation/users?q=0300111')).body.data;
  assert.equal(list.users.length, 1);
  assert.equal(list.users[0].email, 'emp@mod.test');
  assert.equal(list.users[0].requests[0].role, 'employer');
  const d = (await api('Boss', 'GET', `/admin/moderation/users/${u.Emp._id}`)).body.data;
  assert.equal(d.user.phone, '03001112233');
  assert.equal(d.user.passwordHash, undefined, 'never the password');
  assert.equal(d.jobs.length, 1);
  expect(await api('Emp', 'GET', `/admin/moderation/users/${u.Emp._id}`), 403);
});

test('home page text is edited by the admin without code', async () => {
  expect(await api('Emp', 'PUT', '/site-content/home', { titleStart: 'Hacked' }), 403);
  expect(await api('Boss', 'PUT', '/site-content/home', { eyebrow: 'Pakistan\'s education platform', titleStart: 'Your future', titleEmphasis: 'starts', titleEnd: 'here' }), 200);
  const h = (await api(null, 'GET', '/site-content/home')).body.data;
  assert.equal(h.titleEmphasis, 'starts');
  expect(await api('Boss', 'PUT', '/site-content/home', { lead: 'x'.repeat(500) }), 422);
});
