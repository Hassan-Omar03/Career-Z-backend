const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// "Write my CV with AI" uses the person's own AI key, returns a cleaned draft for review and
// never saves it. Without a key the manual builder stays the way.
process.env.NODE_ENV = 'test';
const aiService = require('../src/services/ai.service');
let reply = '';
const calls = [];
mock.method(aiService, 'generate', async (userId, system, prompt) => { calls.push({ userId, system, prompt }); return reply; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, body) {
  const res = await fetch(`${base}/resumes/me/ai-draft`, { method: 'POST', headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const notes = 'I studied BS Physics at GCUF in 2022 and taught physics at City School for two years.';

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const [name, key] of [['Keyed', true], ['NoKey', false]]) {
    u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@aidraft.test`, passwordHash: 'x', emailVerified: true, roles: ['student'], status: 'active' });
    await model('RoleRequest').create({ user: u[name]._id, requestedRole: 'student', status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
    await model('UserProfile').create({ user: u[name]._id, role: 'student', completed: true, percent: 100 });
    if (key) await mongoose.connection.collection('aicredentials').insertOne({ user: u[name]._id, purpose: 'text', scope: 'user', provider: 'openai' });
  }
  await model('Resume').create({ user: u.Keyed._id, headline: 'Old headline' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('no AI key → clear 409; too little detail → 422', async () => {
  const r = await api('NoKey', { notes });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Connect your AI provider/);
  assert.equal((await api('Keyed', { notes: 'hi' })).status, 422);
  assert.equal(calls.length, 0);
});

test('a fenced, messy AI reply becomes a clean draft; nothing is saved', async () => {
  reply = '```json\n' + JSON.stringify({
    headline: 'Physics Teacher <b>bold</b>', summary: 'Dedicated teacher.', experienceLevel: 'wizard', hacker: 'x',
    education: [{ institution: 'GCUF', degree: 'BS Physics', year: '2022', extra: 'y' }, 'nope', {}],
    experience: [{ title: 'Physics Teacher', company: 'City School', duration: '2 years', description: 'Taught grades 9-10.' }],
    skills: ['Physics', 42, '', 'Lab work'], languages: 'English'
  }) + '\n```';
  const r = await api('Keyed', { notes, targetRole: 'Physics Lecturer' });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.headline, 'Physics Teacher bold', 'HTML stripped');
  assert.equal(d.experienceLevel, '', 'invalid enum dropped');
  assert.equal(d.hacker, undefined);
  assert.deepEqual(d.education, [{ institution: 'GCUF', degree: 'BS Physics', year: '2022' }]);
  assert.deepEqual(d.skills, ['Physics', 'Lab work']);
  assert.deepEqual(d.languages, []);
  assert.match(calls.at(-1).prompt, /Physics Lecturer/);
  assert.match(calls.at(-1).system, /Never invent/);
  assert.equal((await model('Resume').findOne({ user: u.Keyed._id })).headline, 'Old headline', 'draft is not saved');
});

test('a reply that is not JSON → 502 with a retry message', async () => {
  reply = 'Sure! Here is your CV: ...';
  const r = await api('Keyed', { notes });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /not a usable CV/);
});
