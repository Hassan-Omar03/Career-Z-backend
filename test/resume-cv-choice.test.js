const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Uploaded CV file (private) and the choice of CV on the apply form: main CV, a CV Version or the
// uploaded file. The employer opens exactly what was sent, even after the student replaces it.
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
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* file */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@cvchoice.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const pdf = (text) => ({ name: 'my cv.pdf', data: 'data:application/pdf;base64,' + Buffer.from(`%PDF-1.4 ${text}`).toString('base64') });
const job = (title) => ({ title, company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Teach physics to secondary classes at our Lahore campus. B.Sc and B.Ed required.' });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Other', 'employer', 'company');
  await account('Stu', 'student');
  await account('Stu2', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const t of ['A', 'B', 'C', 'D']) S[t] = (await api('Employer', 'POST', '/jobs', job(`Physics Teacher ${t}`))).body.data._id;
  await api('Stu', 'PATCH', '/resumes/me', { headline: 'Physics teacher', summary: 'Five years of teaching.', skills: ['physics'] });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('upload checks type and size; the owner can download it; nobody else can', async () => {
  expect(await api('Stu', 'POST', '/resumes/me/cv-file', { name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' }), 422);
  expect(await api('Stu', 'POST', '/resumes/me/cv-file', { name: 'big.pdf', data: 'data:application/pdf;base64,' + Buffer.alloc(2 * 1024 * 1024 + 10).toString('base64') }), 422);
  const r = await api('Stu', 'POST', '/resumes/me/cv-file', pdf('version one'));
  expect(r, 200);
  assert.equal(r.body.data.cvFileName, 'my cv.pdf');
  const own = await api('Stu', 'GET', '/resumes/me/cv-file');
  expect(own, 200);
  assert.match(own.text, /version one/);
  expect(await api('Stu2', 'GET', '/resumes/me/cv-file'), 404, 'only your own file');
  expect(await api('Stu', 'PATCH', '/resumes/me', { cvFile: new mongoose.Types.ObjectId() }), 200);
  assert.ok(String((await model('Resume').findOne({ user: u.Stu._id })).cvFile) === String(r.body.data.cvFile), 'cvFile cannot be set through the builder');
});

test('apply with the uploaded file: the employer downloads exactly it, even after a replacement', async () => {
  const a = await api('Stu', 'POST', `/jobs/${S.A}/apply`, { cv: 'file' });
  expect(a, 201);
  S.appA = a.body.data._id;
  assert.equal(a.body.data.resumeSnapshot.cvSource, 'file');
  const first = await api('Employer', 'GET', `/jobs/applications/${S.appA}/cv-file`);
  expect(first, 200);
  assert.equal(first.type, 'application/pdf');
  assert.match(first.text, /version one/);
  expect(await api('Other', 'GET', `/jobs/applications/${S.appA}/cv-file`), 403, 'employer of another job');
  expect(await api('Stu2', 'GET', `/jobs/applications/${S.appA}/cv-file`), 403);
  expect(await api('Stu', 'GET', `/jobs/applications/${S.appA}/cv-file`), 200, 'the applicant');
  // Replace and then remove: the sent copy survives; an unused file is deleted.
  const old = (await model('Resume').findOne({ user: u.Stu._id })).cvFile;
  await api('Stu', 'POST', '/resumes/me/cv-file', pdf('version two'));
  const two = (await model('Resume').findOne({ user: u.Stu._id })).cvFile;
  assert.ok(await model('PrivateFile').exists({ _id: old }), 'kept: an application uses it');
  await api('Stu', 'POST', '/resumes/me/cv-file', pdf('version three'));
  assert.equal(await model('PrivateFile').exists({ _id: two }), null, 'unused file deleted');
  assert.match((await api('Employer', 'GET', `/jobs/applications/${S.appA}/cv-file`)).text, /version one/);
  expect(await api('Stu', 'DELETE', '/resumes/me/cv-file'), 200);
  expect(await api('Stu', 'POST', `/jobs/${S.B}/apply`, { cv: 'file' }), 422, 'no file to send');
});

test('apply with a CV Version or the main CV; another user\'s version is refused', async () => {
  const v = await api('Stu', 'POST', '/resumes/variants', { name: 'Teaching CV', headline: 'Senior physics teacher', summary: 'Teaching focus.', skills: ['physics', 'lab'] });
  expect(v, 201);
  expect(await api('Stu', 'PATCH', `/resumes/variants/${v.body.data._id}`, { headline: 'Senior physics teacher' }), 200);
  const theirs = (await api('Stu2', 'POST', '/resumes/variants', { name: 'Mine' })).body.data._id;
  expect(await api('Stu', 'POST', `/jobs/${S.B}/apply`, { cv: theirs }), 403);
  expect(await api('Stu', 'POST', `/jobs/${S.B}/apply`, { cv: 'nonsense' }), 422);
  const b = await api('Stu', 'POST', `/jobs/${S.B}/apply`, { cv: v.body.data._id });
  expect(b, 201);
  assert.equal(b.body.data.resumeSnapshot.cvSource, 'variant');
  assert.equal(b.body.data.resumeSnapshot.headline, 'Senior physics teacher');
  assert.equal(b.body.data.resumeSnapshot.variantName, 'Teaching CV');
  const c = await api('Stu', 'POST', `/jobs/${S.C}/apply`, { cv: 'main' });
  assert.equal(c.body.data.resumeSnapshot.headline, 'Physics teacher');
  expect(await api('Employer', 'GET', `/jobs/applications/${c.body.data._id}/cv-file`), 404, 'no file sent');
  // Nothing chosen: the default CV Version (the first one created is the default).
  const d = await api('Stu', 'POST', `/jobs/${S.D}/apply`, {});
  assert.equal(d.body.data.resumeSnapshot.variantName, 'Teaching CV');
});
