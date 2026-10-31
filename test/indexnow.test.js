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
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.indexnow.org')) { sent.push(JSON.parse(opts.body)); return new Response('', { status: 202 }); }
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
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@inow.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const svc = () => require('../src/services/indexNow.service');
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Emp', 'employer');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('first run sends every public page (English and Urdu) with the key', async () => {
  const job = await model('Job').create({ postedBy: u.Emp._id, title: 'Accountant', company: 'ABC', country: 'PK', status: 'active', description: 'x' });
  const r = await svc().run();
  assert.equal(r.lastResult.ok, true);
  const body = sent.at(-1);
  assert.equal(body.host, 'careerz.pk');
  assert.equal(body.key, '2fa3f5920583b019d5ba32b967ed017e');
  assert.equal(body.keyLocation, 'https://careerz.pk/2fa3f5920583b019d5ba32b967ed017e.txt');
  assert.ok(body.urlList.includes('https://careerz.pk/jobs'));
  assert.ok(body.urlList.includes(`https://careerz.pk/jobs/${job._id}`));
  assert.ok(body.urlList.includes(`https://careerz.pk/ur/jobs/${job._id}`));
});

test('later runs send only what changed, including a job an admin removed', async () => {
  const before = sent.length;
  await svc().run();
  assert.equal(sent.length, before, 'nothing changed: nothing sent');
  await new Promise((r) => setTimeout(r, 20));
  const job = await model('Job').findOne();
  job.status = 'removed_by_admin'; await job.save();
  await svc().run();
  assert.deepEqual(sent.at(-1).urlList.sort(), [`https://careerz.pk/jobs/${job._id}`, `https://careerz.pk/ur/jobs/${job._id}`].sort());
});

test('admin sees the status and can send everything now; others cannot', async () => {
  expect(await api('Emp', 'GET', '/seo/indexnow'), 403);
  const s = (await api('Boss', 'GET', '/seo/indexnow')).body.data;
  assert.ok(s.lastSubmitted);
  assert.ok(s.totalSubmitted >= 3);
  const all = await api('Boss', 'POST', '/seo/indexnow/submit');
  expect(all, 200);
  assert.ok(all.body.data.lastResult.count > 50);
});
