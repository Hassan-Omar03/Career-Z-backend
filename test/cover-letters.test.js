const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Saved cover letters: create, list, edit, delete, only your own, and the 20-letter cap.
process.env.NODE_ENV = 'test';
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const letter = (title) => ({ title, role: 'Physics Teacher', company: 'GCUF', body: 'Dear Hiring Manager, I am applying for the Physics Teacher post with five years of experience.' });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const name of ['A', 'B']) {
    u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@cl.test`, passwordHash: 'x', emailVerified: true, roles: ['student'], status: 'active' });
    await model('RoleRequest').create({ user: u[name]._id, requestedRole: 'student', status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
    await model('UserProfile').create({ user: u[name]._id, role: 'student', completed: true, percent: 100 });
  }
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('save, edit, list and delete your own cover letters; not someone else\'s', async () => {
  assert.equal((await api('A', 'POST', '/resumes/cover-letters', { title: 'x', body: 'short' })).status, 422);
  const c = await api('A', 'POST', '/resumes/cover-letters', letter('Teaching'));
  assert.equal(c.status, 201);
  const id = c.body.data._id;
  assert.equal((await api('B', 'PATCH', `/resumes/cover-letters/${id}`, letter('Hijack'))).status, 404);
  assert.equal((await api('B', 'DELETE', `/resumes/cover-letters/${id}`)).status, 404);
  assert.equal((await api('A', 'PATCH', `/resumes/cover-letters/${id}`, letter('Teaching v2'))).body.data.title, 'Teaching v2');
  assert.equal((await api('B', 'GET', '/resumes/cover-letters')).body.data.length, 0);
  assert.equal((await api('A', 'GET', '/resumes/cover-letters')).body.data.length, 1);
  assert.equal((await api('A', 'DELETE', `/resumes/cover-letters/${id}`)).status, 200);
});

test('at most 20 cover letters', async () => {
  for (let i = 0; i < 20; i += 1) await model('CoverLetter').create({ user: u.B._id, ...letter(`L${i}`) });
  assert.equal((await api('B', 'POST', '/resumes/cover-letters', letter('One more'))).status, 409);
});
