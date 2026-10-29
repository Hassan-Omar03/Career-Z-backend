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
const realFetch = globalThis.fetch;
const hooks = [];
let hookStatus = 200;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://hooks.example.com')) { hooks.push({ url: String(url), headers: opts.headers, body: opts.body }); return new Response('ok', { status: hookStatus }); }
  return realFetch(url, opts);
};
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
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@pl.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const crypto = require('crypto');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Staff', 'admin');
  await account('Kid', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('modules: Super Admin turns one off; its API says so for users, admins still pass', async () => {
  assert.equal((await api(null, 'GET', '/plugins/modules')).body.data.visa, true);
  expect(await api('Staff', 'PATCH', '/plugins/admin/modules/visa', { enabled: false }), 403, 'super admin only');
  expect(await api('Boss', 'PATCH', '/plugins/admin/modules/nope', { enabled: false }), 404);
  expect(await api('Boss', 'PATCH', '/plugins/admin/modules/visa', { enabled: false }), 200);
  assert.equal((await api(null, 'GET', '/plugins/modules')).body.data.visa, false);
  const off = await api('Kid', 'GET', '/visa/countries');
  expect(off, 503);
  assert.match(off.body.message, /turned off/);
  expect(await api('Staff', 'GET', '/visa/countries'), 200, 'admins still reach it');
  expect(await api('Boss', 'PATCH', '/plugins/admin/modules/visa', { enabled: true }), 200);
  expect(await api('Kid', 'GET', '/visa/countries'), 200);
});

let plugin;
test('integrations: https only, no private addresses, secret shown once', async () => {
  expect(await api('Staff', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://hooks.example.com/a', events: ['user.registered'] }), 403);
  expect(await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'http://hooks.example.com/a', events: ['user.registered'] }), 422, 'https');
  expect(await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://127.0.0.1/a', events: ['user.registered'] }), 422, 'loopback');
  expect(await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://192.168.1.5/a', events: ['user.registered'] }), 422, 'private');
  expect(await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://localhost/a', events: ['user.registered'] }), 422, 'localhost');
  expect(await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://hooks.example.com/a', events: [] }), 422, 'events');
  const r = await api('Boss', 'POST', '/plugins/admin', { name: 'CRM', url: 'https://hooks.example.com/crm', events: ['user.registered', 'payment.approved'] });
  expect(r, 201);
  plugin = r.body.data;
  assert.match(plugin.secret, /^czwh_/);
  const listed = (await api('Boss', 'GET', '/plugins/admin')).body.data[0];
  assert.equal(listed.secret, undefined, 'never listed again');
});

test('events arrive signed; test button; disabled plugins get nothing', async () => {
  const t = await api('Boss', 'POST', `/plugins/admin/${plugin._id}/test`);
  expect(t, 200);
  assert.equal(t.body.data.ok, true);
  const h = hooks.at(-1);
  const sig = crypto.createHmac('sha256', plugin.secret).update(`${h.headers['X-CareerZ-Timestamp']}.${h.body}`).digest('hex');
  assert.equal(h.headers['X-CareerZ-Signature'], `sha256=${sig}`, 'valid signature');
  require('../src/services/plugins.service').emit('user.registered', { userId: 'x1', role: 'student' });
  await wait(300);
  assert.equal(JSON.parse(hooks.at(-1).body).event, 'user.registered');
  assert.equal(JSON.parse(hooks.at(-1).body).data.userId, 'x1');
  const before = hooks.length;
  require('../src/services/plugins.service').emit('order.placed', { orderId: 'o1' });
  await wait(200);
  assert.equal(hooks.length, before, 'not subscribed');
  expect(await api('Boss', 'PATCH', `/plugins/admin/${plugin._id}`, { enabled: false }), 200);
  require('../src/services/plugins.service').emit('user.registered', { userId: 'x2' });
  await wait(200);
  assert.equal(hooks.length, before, 'disabled');
  const log = (await api('Boss', 'GET', '/plugins/admin')).body.data[0].deliveries;
  assert.equal(log.length, 2);
});

test('a plugin that keeps failing turns itself off; rotate secret; delete', async () => {
  expect(await api('Boss', 'PATCH', `/plugins/admin/${plugin._id}`, { enabled: true }), 200);
  hookStatus = 500;
  const svc = require('../src/services/plugins.service');
  const p = await model('Plugin').findById(plugin._id).select('+secret');
  for (let i = 0; i < 20; i += 1) await svc.deliver(p, 'user.registered', { i });
  assert.equal((await model('Plugin').findById(plugin._id)).enabled, false);
  hookStatus = 200;
  const rot = await api('Boss', 'PATCH', `/plugins/admin/${plugin._id}`, { rotateSecret: true });
  assert.notEqual(rot.body.data.secret, plugin.secret);
  expect(await api('Boss', 'DELETE', `/plugins/admin/${plugin._id}`), 200);
  assert.equal((await api('Boss', 'GET', '/plugins/admin')).body.data.length, 0);
});
