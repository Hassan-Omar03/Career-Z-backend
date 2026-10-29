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
const ai = require('../src/services/ai.service');
let calls = [];
mock.method(ai, 'generate', async (uid, system, prompt) => {
  calls.push({ uid: String(uid), system, prompt });
  if (/interview questions/.test(system)) return JSON.stringify({ questions: [{ question: 'Tell me about a time you handled a difficult class.', kind: 'behavioural' }, { question: 'How do you plan a lesson on fractions?', kind: 'technical' }, { question: 'Why do you want this job?', kind: 'hr' }] });
  if (/Score the candidate/.test(system)) return /fractions/.test(prompt) ? '{"score":8,"feedback":"Clear plan.","betterAnswer":"Start with pizza slices.","confidence":"high","confidenceReason":"Direct"}' : '{"score":4,"feedback":"Too vague.","betterAnswer":"Use STAR.","confidence":"low","confidenceReason":"Hesitant"}';
  return '{"verdict":"Close to ready.","strengths":["Lesson planning"],"improvements":["Give examples"],"nextSteps":["Practise STAR answers"]}';
});
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
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@mi.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Cand', 'teacher');
  await account('Other', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

let id;
test('start: AI writes role questions on the candidate\'s own key', async () => {
  expect(await api('Cand', 'POST', '/mock-interviews', { role: 'x' }), 422);
  const r = await api('Cand', 'POST', '/mock-interviews', { role: 'Primary school maths teacher', level: 'junior', count: 3 });
  expect(r, 201);
  id = r.body.data._id;
  assert.equal(r.body.data.questions.length, 3);
  assert.equal(calls.at(-1).uid, String(u.Cand._id), 'own AI key');
  expect(await api('Other', 'GET', `/mock-interviews/${id}`), 404, 'private');
});

test('each answer gets a score, feedback, model answer and an explained confidence level', async () => {
  expect(await api('Cand', 'POST', `/mock-interviews/${id}/finish`), 422, 'nothing answered yet');
  const weak = await api('Cand', 'POST', `/mock-interviews/${id}/answer`, { index: 0, answer: 'Um, maybe I think I would, you know, talk to them? Not sure.', seconds: 40 });
  expect(weak, 200);
  const q0 = weak.body.data.questions[0];
  assert.equal(q0.score, 4);
  assert.equal(q0.confidence.level, 'low');
  assert.ok(q0.confidence.signals.some((s) => /unsure/.test(s)), 'hedging explained');
  const strong = await api('Cand', 'POST', `/mock-interviews/${id}/answer`, { index: 1, answer: 'I start with a warm-up using 4 pizza slices, then I model one example on the board, pairs practise 6 questions, and I end with an exit ticket. Last term I improved my class average from 52 to 71 percent with this plan, and I designed extra worksheets for weak students.', spoken: true });
  const q1 = strong.body.data.questions[1];
  assert.equal(q1.score, 8);
  assert.equal(q1.confidence.level, 'high');
  assert.equal(q1.spoken, true);
  assert.equal(q1.betterAnswer, 'Start with pizza slices.');
  expect(await api('Cand', 'POST', `/mock-interviews/${id}/answer`, { index: 9, answer: 'hello there' }), 404);
});

test('finish: overall score, confidence and the AI report; list and delete', async () => {
  const r = await api('Cand', 'POST', `/mock-interviews/${id}/finish`);
  expect(r, 200);
  assert.equal(r.body.data.status, 'completed');
  assert.equal(r.body.data.summary.overallScore, 60);
  assert.ok(['low', 'medium', 'high'].includes(r.body.data.summary.confidence));
  assert.deepEqual(r.body.data.summary.nextSteps, ['Practise STAR answers']);
  expect(await api('Cand', 'POST', `/mock-interviews/${id}/answer`, { index: 2, answer: 'Because I love teaching' }), 409, 'finished');
  assert.equal((await api('Cand', 'GET', '/mock-interviews')).body.data.length, 1);
  expect(await api('Cand', 'DELETE', `/mock-interviews/${id}`), 200);
  assert.equal((await api('Cand', 'GET', '/mock-interviews')).body.data.length, 0);
});
