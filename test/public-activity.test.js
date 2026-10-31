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
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@act.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Emp', 'employer');
  await account('Seller', 'marketplace_seller');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('newest public items with labels and links; removed and draft items never show', async () => {
  const job = await model('Job').create({ postedBy: u.Emp._id, title: 'Sales Officer', company: 'Engro Corporation', city: 'Karachi', country: 'PK', status: 'active', description: 'x' });
  await model('Job').create({ postedBy: u.Emp._id, title: 'Fake job', company: 'Scam', country: 'PK', status: 'removed_by_admin', description: 'x' });
  await model('Product').create({ seller: u.Seller._id, title: 'FSc Chemistry notes', description: 'n', price: 800, currency: 'PKR', stock: 3, category: 'notes', status: 'active' });
  const r = await api(null, 'GET', '/public/activity');
  expect(r, 200);
  const items = r.body.data;
  const j = items.find((x) => x.kind === 'job');
  assert.equal(j.label, 'New job');
  assert.equal(j.text, 'Sales Officer at Engro Corporation, Karachi');
  assert.equal(j.link, `/jobs/${job._id}`);
  assert.ok(items.some((x) => x.kind === 'product' && x.text === 'FSc Chemistry notes in Lahore'));
  assert.ok(!items.some((x) => /Fake job/.test(x.text)), 'removed jobs never show');
});
