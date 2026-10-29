const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Interview Center (master 12.9): CareerZ video by default, or Google Meet / Zoom / Teams / a
// custom https link. Outside links must match the chosen service; the built-in room only opens
// for built-in interviews.
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
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@ivprov.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const soon = () => new Date(Date.now() + 864e5).toISOString();

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Cand', 'student');
  await account('Cand2', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const job = { title: 'Physics Teacher', company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Teach physics to secondary classes at our Lahore campus. B.Sc and B.Ed required.' };
  S.job = (await api('Employer', 'POST', '/jobs', job)).body.data._id;
  S.app = (await api('Cand', 'POST', `/jobs/${S.job}/apply`, {})).body.data._id;
  S.app2 = (await api('Cand2', 'POST', `/jobs/${S.job}/apply`, {})).body.data._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('built-in is the default and gets a CareerZ room link', async () => {
  const r = await api('Employer', 'POST', `/jobs/applications/${S.app}/schedule-interview`, { scheduledDate: soon(), mode: 'online' });
  expect(r, 201);
  assert.equal(r.body.data.provider, 'careerz');
  assert.equal(r.body.data.externalUrl, '');
  assert.match(r.body.data.meetingLink, /interview=/);
});

test('outside services need a matching https link', async () => {
  const path = `/jobs/applications/${S.app2}/schedule-interview`;
  expect(await api('Employer', 'POST', path, { scheduledDate: soon(), mode: 'online', provider: 'zoom' }), 422, 'link required');
  expect(await api('Employer', 'POST', path, { scheduledDate: soon(), mode: 'online', provider: 'zoom', externalUrl: 'https://meet.google.com/abc-defg-hij' }), 422, 'meet link is not zoom');
  expect(await api('Employer', 'POST', path, { scheduledDate: soon(), mode: 'online', provider: 'custom', externalUrl: 'http://example.com/room' }), 422, 'https only');
  expect(await api('Employer', 'POST', path, { scheduledDate: soon(), mode: 'online', provider: 'teams', externalUrl: 'not a url' }), 422);
  const r = await api('Employer', 'POST', path, { scheduledDate: soon(), mode: 'online', provider: 'zoom', externalUrl: 'https://us02web.zoom.us/j/123456789' });
  expect(r, 201);
  assert.equal(r.body.data.provider, 'zoom');
  assert.equal(r.body.data.meetingLink, 'https://us02web.zoom.us/j/123456789');
  S.zoomInterview = r.body.data._id;
});

test('the built-in room refuses an interview held on an outside service', async () => {
  const r = await api('Cand2', 'GET', `/jobs/interviews/${S.zoomInterview}/video`);
  assert.equal(r.status, 409);
  assert.match(r.text, /outside meeting service/);
});

test('switching provider on update keeps the link consistent', async () => {
  const bad = await api('Employer', 'PATCH', `/jobs/interviews/${S.zoomInterview}`, { provider: 'google_meet' });
  expect(bad, 422, 'old zoom link is not a meet link');
  const ok = await api('Employer', 'PATCH', `/jobs/interviews/${S.zoomInterview}`, { provider: 'google_meet', externalUrl: 'https://meet.google.com/abc-defg-hij' });
  expect(ok, 200);
  const doc = await model('Interview').findById(S.zoomInterview).lean();
  assert.equal(doc.provider, 'google_meet');
  assert.equal(doc.meetingLink, 'https://meet.google.com/abc-defg-hij');
  expect(await api('Employer', 'PATCH', `/jobs/interviews/${S.zoomInterview}`, { provider: 'careerz' }), 200);
  const back = await model('Interview').findById(S.zoomInterview).lean();
  assert.equal(back.provider, 'careerz');
  assert.equal(back.externalUrl, '');
  assert.match(back.meetingLink, /interview=/);
});
