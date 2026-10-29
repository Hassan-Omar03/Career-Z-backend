const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Master 13.7 Visa & Recruitment Support Center: country rules, verified visa consultants,
// visa case tracking through every stage, documents, AI information-only assistant.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const ai = require('../src/services/ai.service');
let lastPrompt = '';
mock.method(ai, 'generate', async (uid, system, prompt) => { lastPrompt = `${system}\n${prompt}`; return 'You need a passport and a work permit. Only the UAE government decides.'; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@visa.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, subtype, status: 'approved', approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrCjEgMCBvYmoKPDw+PgplbmRvYmoKdHJhaWxlcgo8PD4+CiUlRU9G';

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Employer', 'employer', 'recruitment_agency');
  await account('Agent', 'education_agent', 'agency');
  await account('Cand', 'student');
  await account('Other', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const job = await model('Job').create({ postedBy: u.Employer._id, title: 'Nurse', company: 'Dubai Care', country: 'AE', status: 'active', visaSponsorship: true, description: 'Hospital nurse in Dubai.' });
  S.job = job._id;
  S.app = (await model('JobApplication').create({ job: job._id, applicant: u.Cand._id, status: 'pending' }))._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('admin keeps country rules; anyone reads them; only admins edit', async () => {
  expect(await api('Employer', 'PUT', '/visa/admin/countries', { country: 'AE', name: 'UAE' }), 403);
  expect(await api('Boss', 'PUT', '/visa/admin/countries', { country: 'UAE', name: 'UAE' }), 422, '2-letter code');
  const r = await api('Boss', 'PUT', '/visa/admin/countries', { country: 'ae', name: 'United Arab Emirates', workPermit: 'Employer applies for the work permit through MOHRE.', workingHours: '8 hours a day, 48 a week.', visaTypes: ['Employment visa', 'Visit visa'], requiredDocuments: ['Passport', 'Photo', 'Degree attested'], officialLinks: [{ label: 'MOHRE', url: 'https://www.mohre.gov.ae' }, { label: 'bad', url: 'http://x' }] });
  expect(r, 200);
  assert.equal(r.body.data.officialLinks.length, 1, 'only https links');
  const list = await api(null, 'GET', '/visa/countries');
  assert.equal(list.body.data[0].country, 'AE');
  assert.match((await api(null, 'GET', '/visa/countries/ae')).body.data.workingHours, /48/);
});

test('verified visa consultants: an admin checks an agency agent\'s licence', async () => {
  expect(await api('Boss', 'PATCH', `/visa/admin/consultants/${u.Agent._id}`, { verified: true }), 422, 'licence number needed');
  expect(await api('Boss', 'PATCH', `/visa/admin/consultants/${u.Cand._id}`, { verified: true, licenseNo: 'OEP-1234' }), 404, 'agents only');
  expect(await api('Boss', 'PATCH', `/visa/admin/consultants/${u.Agent._id}`, { verified: true, licenseNo: 'OEP-1234/RWP', countries: ['ae', 'sa'] }), 200);
  const c = await api(null, 'GET', '/visa/consultants?country=AE');
  assert.equal(c.body.data.length, 1);
  assert.equal(c.body.data[0].licenseNo, 'OEP-1234/RWP');
});

test('visa case: opened by the hiring side, documents, consultant, every stage, approved; others locked out', async () => {
  expect(await api('Employer', 'POST', `/visa/applications/${S.app}/case`), 409, 'candidate not at interview yet');
  await model('JobApplication').updateOne({ _id: S.app }, { $set: { status: 'selected' } });
  expect(await api('Other', 'POST', `/visa/applications/${S.app}/case`), 403);
  const o = await api('Employer', 'POST', `/visa/applications/${S.app}/case`, { visaType: 'Employment visa' });
  expect(o, 201);
  S.case = o.body.data._id;
  const stage = (k) => o.body.data.stages.find((s) => s.key === k);
  assert.equal(stage('employer_verified').done, true, 'a verified employer is checked by CareerZ');
  assert.equal(stage('interview_completed').done, true, 'selected = interview done');
  expect(await api('Employer', 'POST', `/visa/applications/${S.app}/case`), 409, 'one case per application');
  const mine = await api('Cand', 'GET', '/visa/cases/mine');
  assert.equal(mine.body.data.length, 1);
  expect(await api('Other', 'GET', `/visa/cases/${S.case}`), 404, 'private');
  expect(await api('Cand', 'POST', `/visa/cases/${S.case}/documents`, { name: 'Passport', file: { name: 'passport.pdf', data: PDF } }), 200);
  let c = (await api('Cand', 'GET', `/visa/cases/${S.case}`)).body.data;
  assert.equal(c.stages.find((s) => s.key === 'documents_submitted').done, true, 'uploading marks documents submitted');
  expect(await api('Employer', 'GET', `/visa/cases/${S.case}/documents/0`), 200, 'the hiring side can open the document');
  expect(await api('Cand', 'PATCH', `/visa/cases/${S.case}/stage`, { key: 'visa_approved', done: true }), 403, 'the candidate cannot tick steps');
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/stage`, { key: 'agency_verified', done: true }), 409, 'needs a consultant');
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/consultant`, { consultant: String(u.Other._id) }), 422, 'must be verified');
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/consultant`, { consultant: String(u.Agent._id) }), 200);
  for (const key of ['agency_verified', 'offer_letter_received', 'visa_processing']) expect(await api('Agent', 'PATCH', `/visa/cases/${S.case}/stage`, { key, done: true, note: 'ok' }), 200, key);
  expect(await api('Agent', 'PATCH', `/visa/cases/${S.case}/outcome`, { status: 'approved', note: 'Visa stamped' }), 200);
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/stage`, { key: 'travel_completed', done: true }), 200, 'travel is marked after approval');
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/outcome`, { status: 'closed' }), 200);
  expect(await api('Employer', 'PATCH', `/visa/cases/${S.case}/stage`, { key: 'visa_processing', done: false }), 409, 'a closed case is final');
});

test('AI visa assistant: information only, with the country notes and a disclaimer', async () => {
  expect(await api('Cand', 'POST', '/visa/ask', { question: 'hi' }), 422);
  const r = await api('Cand', 'POST', '/visa/ask', { country: 'AE', question: 'What documents do I need for a nurse job in Dubai?' });
  expect(r, 200);
  assert.match(r.body.data.disclaimer, /government/);
  assert.match(lastPrompt, /never approve/i);
  assert.match(lastPrompt, /MOHRE/);
  const n = await model('Notification').find({ user: u.Cand._id, category: 'visa' }).lean();
  assert.ok(n.length >= 4, 'the candidate is told each step');
});
