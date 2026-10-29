const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Super Admin Ad Management: global and per-placement switches, never on live class / exam /
// chat / wallet / payment, impressions and clicks, and an institute buying ad-free dashboards.
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
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@ads.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Owner', 'institution');
  await account('Kid', 'student');
  await account('Outsider', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  school = await model('Institution').create({ name: 'Ad School', slug: 'ad-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  await model('StudentInstitutionMembership').create({ student: u.Kid._id, institution: school._id, status: 'active' });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('only the Super Admin makes ads; never on live class, exam, chat, wallet or payment', async () => {
  expect(await api('Owner', 'POST', '/ads/admin', { title: 'X', link: 'https://x.pk', placements: ['home'] }), 403);
  expect(await api('Boss', 'POST', '/ads/admin', { title: 'Bad', link: 'http://x.pk', placements: ['home'] }), 422, 'https only');
  expect(await api('Boss', 'POST', '/ads/admin', { title: 'Bad', link: 'https://x.pk', placements: ['home', 'exam'] }), 422, 'never on exams');
  expect(await api('Boss', 'POST', '/ads/admin', { title: 'Bad', link: 'https://x.pk', placements: [] }), 422, 'needs a placement');
  const r = await api('Boss', 'POST', '/ads/admin', { title: 'IELTS Prep', advertiser: 'Lahore Academy', link: 'https://ielts.example.pk', image: PNG, placements: ['home', 'dashboard'] });
  expect(r, 201);
  expect(await api(null, 'GET', '/ads/slot?placement=wallet'), 200);
  assert.equal((await api(null, 'GET', '/ads/slot?placement=wallet')).body.data, null);
});

test('ads are off until the Super Admin turns them on, and each placement has its own switch', async () => {
  assert.equal((await api(null, 'GET', '/ads/slot?placement=home')).body.data, null, 'off by default');
  expect(await api('Boss', 'PUT', '/ads/admin/config', { enabled: true }), 200);
  const ad = (await api(null, 'GET', '/ads/slot?placement=home')).body.data;
  assert.equal(ad.title, 'IELTS Prep');
  assert.equal((await api(null, 'GET', '/ads/slot?placement=blog')).body.data, null, 'not placed on the blog');
  expect(await api('Boss', 'PUT', '/ads/admin/config', { placements: { home: false } }), 200);
  assert.equal((await api(null, 'GET', '/ads/slot?placement=home')).body.data, null, 'home switched off');
  expect(await api('Boss', 'PUT', '/ads/admin/config', { placements: { home: true } }), 200);
  const go = await api(null, 'GET', `/ads/${ad._id}/go`);
  expect(go, 302);
  assert.equal(go.headers.get('location'), 'https://ielts.example.pk');
  const row = (await api('Boss', 'GET', '/ads/admin')).body.data[0];
  assert.equal(row.impressions, 1);
  assert.equal(row.clicks, 1);
  expect(await api('Boss', 'PATCH', `/ads/admin/${ad._id}`, { endsAt: new Date(Date.now() - 864e5).toISOString() }), 200);
  assert.equal((await api(null, 'GET', '/ads/slot?placement=home')).body.data, null, 'ended ads stop');
  expect(await api('Boss', 'PATCH', `/ads/admin/${ad._id}`, { endsAt: null }), 200);
});

test('an institute buys ad-free dashboards; its owner and students then see no dashboard ads', async () => {
  assert.ok((await api('Kid', 'GET', '/ads/slot?placement=dashboard')).body.data, 'student sees a dashboard ad');
  expect(await api('Boss', 'PUT', '/manual-payments/platform-account', { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819', qr: PNG }), 200);
  expect(await api('Boss', 'PUT', '/ads/admin/config', { adFree: { monthly: 1500 } }), 200);
  expect(await api('Kid', 'GET', `/manual-payments/quote/ad_free/${school._id}`), 403, 'only the owner buys');
  const q = await api('Owner', 'GET', `/manual-payments/quote/ad_free/${school._id}?period=monthly`);
  expect(q, 200);
  const amount = q.body.data.commission ?? q.body.data.price;
  const sent = await api('Owner', 'POST', `/manual-payments/ad_free/${school._id}`, { period: 'monthly', phone: '03001234567', commission: { amount, transactionId: 'TXNADFREE1', paidOn: new Date().toISOString(), file: { name: 'r.png', data: PNG } } });
  expect(sent, 201);
  expect(await api('Boss', 'PATCH', `/manual-payments/${sent.body.data._id}/decide`, { decision: 'approve' }), 200);
  const until = (await model('Institution').findById(school._id).lean()).adFreeUntil;
  assert.ok(until > new Date(Date.now() + 29 * 864e5));
  assert.equal((await api('Kid', 'GET', '/ads/slot?placement=dashboard')).body.data, null, 'student of an ad-free institute');
  assert.equal((await api('Owner', 'GET', '/ads/slot?placement=dashboard')).body.data, null, 'owner');
  assert.ok((await api('Outsider', 'GET', '/ads/slot?placement=dashboard')).body.data, 'others still see ads');
  assert.ok((await api('Kid', 'GET', '/ads/slot?placement=home')).body.data, 'public pages still have ads');
  assert.equal((await api('Boss', 'GET', '/ads/admin/ad-free')).body.data[0].name, 'Ad School');
});
