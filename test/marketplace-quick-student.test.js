const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Marketplace: a verified student can sell (master: in the student marketplace a student is
// both buyer and seller), and a visitor without an account buys through quick checkout.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
const mails = [];
mock.method(emailService, 'sendEmail', async (m) => { mails.push(m); return { ok: true }; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body, bearer) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, approved = true) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@mkt.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending', approvedAt: approved ? new Date(Date.now() - 30 * 864e5) : null });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Stud', 'student');
  await account('NewStud', 'student', false);
  await account('Boss', 'super_admin');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('a verified student sells: lists a product, admin approves, it is public; an unverified one cannot', async () => {
  const body = { title: 'O-level Physics notes (printed)', category: 'books', price: 1500, currency: 'PKR', stock: 3, description: 'Complete printed notes with past papers.' };
  expect(await api('NewStud', 'POST', '/marketplace/products', body), 403, 'unverified student');
  const r = await api('Stud', 'POST', '/marketplace/products', body);
  expect(r, 201);
  S.product = r.body.data._id;
  assert.equal((await api('Stud', 'GET', '/marketplace/products/mine/list')).status, 200, 'student sees own listings');
  expect(await api('Boss', 'PATCH', `/marketplace/products/${S.product}/moderate`, { status: 'active' }), 200);
  const pub = await api(null, 'GET', '/public/marketplace');
  assert.ok(pub.body.data.items.some((p) => p._id === S.product), 'student listing is public');
  expect(await api('Stud', 'GET', '/marketplace/orders/selling'), 200, 'student sees orders received');
});

test('quick checkout: a visitor gets a code by email, becomes a light buyer and orders', async () => {
  expect(await api(null, 'POST', '/marketplace/quick-checkout/start', { name: 'Ali', email: 'bad', phone: '0300' }), 422);
  expect(await api(null, 'POST', '/marketplace/quick-checkout/start', { name: 'Stud Person', email: 'stud@mkt.test', phone: '03001234567' }), 409, 'existing members log in');
  mails.length = 0;
  expect(await api(null, 'POST', '/marketplace/quick-checkout/start', { name: 'Visitor Buyer', email: 'visitor@outside.test', phone: '03111234567' }), 200);
  const code = (mails.find((m) => m.to === 'visitor@outside.test')?.text || '').match(/\b\d{6}\b/)?.[0];
  assert.ok(code, 'a 6-digit code was emailed');
  expect(await api(null, 'POST', '/marketplace/quick-checkout/verify', { email: 'visitor@outside.test', code: '000000' }), 422, 'wrong code');
  const v = await api(null, 'POST', '/marketplace/quick-checkout/verify', { email: 'visitor@outside.test', code });
  expect(v, 200);
  const token = v.body.data.accessToken;
  assert.ok(token);
  assert.deepEqual(v.body.data.user.roles, []);
  assert.equal(v.body.data.user.quickBuyer, true);
  const o = await api(null, 'POST', `/marketplace/products/${S.product}/orders`, { quantity: 1, shipping: { name: 'Test Buyer', phone: '03001234567', cnic: '35202-1234567-1', address: 'House 1, Street 2, Model Town', city: 'Lahore' } }, token);
  expect(o, 201, 'the quick buyer can order');
  const mine = await api(null, 'GET', '/marketplace/orders/mine', null, token);
  assert.equal(mine.body.data.length, 1);
  expect(await api(null, 'POST', '/marketplace/quick-checkout/start', { name: 'Visitor Buyer', email: 'visitor@outside.test', phone: '03111234567' }), 409, 'used once; then log in');
});
