const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// The full event → matching → database notification → email → direct link → unsubscribe chain for
// job alerts (Job Marketplace 19), the weekly digest, application notifications, the Master 12.10
// hiring stages with joining confirmation, and scholarship alerts (Notification Center 35).
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
process.env.PUBLIC_SITE_URL = 'https://careerz.test';
const emailService = require('../src/services/email.service');
const emails = [];
mock.method(emailService, 'sendEmail', async (msg) => { emails.push(msg); return { ok: true }; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
const { runDigest } = require('../src/services/jobDigest.service');
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, extra = {}, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@alerts.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', ...extra });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const emailsTo = (name) => emails.filter((e) => e.to === u[name].email);
const notes = (name, extra = {}) => model('Notification').find({ user: u[name]._id, ...extra }).lean();
const job = (extra = {}) => ({ title: 'React Developer', company: 'Insight Co', country: 'PK', city: 'Lahore', category: 'it_technical', type: 'full_time', salaryMin: 100000, salaryMax: 150000, currency: 'PKR', description: 'Build web applications with React and Node.js for our Lahore clients. Two years of experience.', skills: ['react'], ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', {}, 'company');
  await account('Agent', 'education_agent', {}, 'individual');
  await account('Donor', 'donor');
  await account('Skilled', 'student');               // CV skill react
  await account('Alerted', 'student', { city: 'Karachi' }); // saved alert keyword "node", any city
  await account('Elsewhere', 'student', { city: 'Quetta' }); // has react skill but wrong city
  await account('Teacher', 'teacher');               // teaching jobs in Lahore
  await account('Muted', 'student');                 // react skill, alerts switched off
  await account('Abroad', 'student', { country: 'AE', city: 'Dubai' });
  for (const n of ['Skilled', 'Elsewhere', 'Muted']) await model('Resume').create({ user: u[n]._id, skills: ['React'] });
  await model('JobAlert').create({ user: u.Alerted._id, keywords: 'node' });
  await model('User').updateOne({ _id: u.Muted._id }, { $set: { 'notificationPreferences.jobAlertsInApp': false, 'notificationPreferences.jobAlertsEmail': false } });
  await model('StudentProfile').create({ user: u.Skilled._id, program: 'Computer Science', skills: ['react'] });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { emails.length = 0; });

test('publishing a job alerts exactly the matching people, in the app and by email, with a direct link', async () => {
  const r = await api('Employer', 'POST', '/jobs', job());
  expect(r, 201);
  S.job = r.body.data._id;
  const got = async (n) => (await notes(n, { category: 'job_alert' }));
  assert.equal((await got('Skilled')).length, 1, 'skills + same city');
  assert.equal((await got('Alerted')).length, 1, 'saved alert keyword');
  assert.equal((await got('Elsewhere')).length, 0, 'wrong city');
  assert.equal((await got('Teacher')).length, 0, 'not a teaching job');
  assert.equal((await got('Abroad')).length, 0);
  const [n] = await got('Skilled');
  assert.equal(n.link, `/jobs/${S.job}`);
  assert.match(n.body, /Matches your skills: react/);
  const mail = emailsTo('Skilled')[0];
  assert.ok(mail, 'emailed');
  assert.match(mail.html, new RegExp(`https://careerz.test/jobs/${S.job}`), 'email button opens the exact job');
  assert.match(mail.html, /api\/notifications\/unsubscribe\?token=[a-f0-9]{48}&amp;type=jobAlertsEmail|api\/notifications\/unsubscribe\?token=[a-f0-9]{48}&type=jobAlertsEmail/);
  // Muted: no visible notification and no email, but the event is recorded once.
  const muted = await notes('Muted');
  assert.equal(muted.length, 1);
  assert.equal(muted[0].muted, true);
  assert.equal(emailsTo('Muted').length, 0);
  expect(await api('Muted', 'GET', '/notifications/mine'), 200);
  assert.equal((await api('Muted', 'GET', '/notifications/mine')).body.data.length, 0);
  // Re-running the alert for the same job sends nothing new.
  const again = await require('../src/services/jobAlerts.service').sendForJob(await model('Job').findById(S.job));
  assert.equal(again, 0);
});

test('a teaching job reaches teachers nearby; held jobs alert nobody until an admin approves', async () => {
  await api('Employer', 'POST', '/jobs', job({ title: 'Physics Teacher', category: 'teaching', skills: [], description: 'Teach physics to secondary classes at our Lahore campus. B.Sc and B.Ed required.' }));
  assert.equal((await notes('Teacher', { category: 'job_alert' })).length, 1);
  const held = await api('Agent', 'POST', '/jobs', job({ title: 'Node Engineer', company: 'Gulf Co', description: 'Pay registration fee of Rs 9000 to apply for this Node.js role.' }));
  assert.equal(held.body.data.status, 'pending_review');
  assert.equal((await notes('Alerted', { category: 'job_alert', link: `/jobs/${held.body.data._id}` })).length, 0, 'no alert while held');
});

test('email unsubscribe link turns off that one kind of email; settings can be read and changed', async () => {
  const token = (await model('User').findById(u.Skilled._id)).unsubscribeToken;
  assert.ok(token);
  const page = await api(null, 'GET', `/notifications/unsubscribe?token=${token}&type=jobAlertsEmail`);
  expect(page, 200);
  assert.match(page.text, /You are unsubscribed/);
  assert.match((await api(null, 'GET', '/notifications/unsubscribe?token=bad&type=jobAlertsEmail')).text, /not valid/);
  const s = await api('Skilled', 'GET', '/notifications/settings');
  assert.equal(s.body.data.preferences.jobAlertsEmail, false);
  assert.equal(s.body.data.preferences.jobAlertsInApp, true);
  await api('Employer', 'POST', '/jobs', job({ title: 'React Native Developer' }));
  assert.equal(emailsTo('Skilled').length, 0, 'no more job alert emails');
  assert.equal((await notes('Skilled', { category: 'job_alert' })).length, 2, 'still in the app');
  expect(await api('Skilled', 'PUT', '/notifications/settings', { jobPreferences: { categories: ['astronaut'] } }), 422);
  const saved = await api('Skilled', 'PUT', '/notifications/settings', { preferences: { jobAlertsEmail: true }, jobPreferences: { categories: ['finance_accounts'], cities: 'Islamabad, Lahore' } });
  expect(saved, 200);
  assert.deepEqual(saved.body.data.jobPreferences.cities, ['Islamabad', 'Lahore']);
  await api('Employer', 'POST', '/jobs', job({ title: 'Accountant', category: 'finance_accounts', city: 'Islamabad', skills: [], description: 'Maintain ledgers and payroll for our Islamabad office. ACCA part qualified.' }));
  assert.equal((await notes('Skilled', { category: 'job_alert', title: /Accountant/ })).length, 1, 'followed category in a preferred city');
});

test('weekly digest emails matching new jobs once a week, and respects unsubscribe', async () => {
  const r = await runDigest(new Date());
  assert.ok(r.emailed >= 2);
  const mail = emailsTo('Skilled').find((e) => /new job/.test(e.subject));
  assert.ok(mail, 'digest sent');
  assert.match(mail.text, /React Developer/);
  assert.match(mail.text, /type=weeklyDigest/);
  emails.length = 0;
  assert.equal((await runDigest(new Date())).emailed, 0, 'not again within the week');
  await model('User').updateOne({ _id: u.Alerted._id }, { $set: { lastDigestAt: null, 'notificationPreferences.weeklyDigest': false } });
  await runDigest(new Date());
  assert.equal(emailsTo('Alerted').length, 0, 'digest switched off');
});

test('hiring stages: history, notes, agent joining needs the candidate, then commission; employers confirm directly', async () => {
  const agentJob = await api('Agent', 'POST', '/jobs', job({ title: 'Sales Officer', category: 'sales_marketing', skills: [], description: 'Field sales for an FMCG distributor in Lahore. Graduates welcome; training provided.' }));
  assert.equal(agentJob.body.data.status, 'active');
  expect(await api('Skilled', 'POST', `/jobs/${agentJob.body.data._id}/apply`, { coverLetter: 'Hello' }), 201);
  assert.ok(emailsTo('Agent').some((e) => /New application/.test(e.subject)), 'agent emailed about the application');
  assert.ok(emailsTo('Skilled').some((e) => /Application received/.test(e.subject)), 'applicant receipt');
  const app = await model('JobApplication').findOne({ job: agentJob.body.data._id });
  for (const s of ['viewed', 'shortlisted', 'interview', 'final_interview', 'selected', 'accepted']) expect(await api('Agent', 'PATCH', `/jobs/applications/${app._id}/status`, { status: s, note: s === 'interview' ? 'Interview on Monday at 10am.' : '' }), 200, s);
  assert.ok((await notes('Skilled', { category: 'application' })).some((n) => n.body === 'Interview on Monday at 10am.'), 'agent note reaches the candidate');
  expect(await api('Agent', 'PATCH', `/jobs/applications/${app._id}/status`, { status: 'completed' }), 409, 'cannot complete before joining');
  const joined = await api('Agent', 'PATCH', `/jobs/applications/${app._id}/status`, { status: 'hired' });
  assert.equal(joined.body.data.joining.confirmed, false, 'agent alone cannot confirm joining');
  assert.equal(await model('Commission').countDocuments(), 0, 'no commission yet');
  expect(await api('Elsewhere', 'POST', `/jobs/applications/${app._id}/confirm-joining`), 404, 'only the candidate');
  const conf = await api('Skilled', 'POST', `/jobs/applications/${app._id}/confirm-joining`);
  expect(conf, 200);
  assert.equal(conf.body.data.joining.via, 'candidate');
  const commission = await model('Commission').findOne({ application: app._id });
  assert.ok(commission, 'commission after confirmed joining');
  assert.equal(String(commission.agent), String(u.Agent._id));
  assert.equal((await model('Job').findById(agentJob.body.data._id)).status, 'filled');
  expect(await api('Agent', 'PATCH', `/jobs/applications/${app._id}/status`, { status: 'completed' }), 200);
  const history = (await model('JobApplication').findById(app._id)).statusHistory.map((h) => `${h.status}:${h.byRole}`);
  assert.deepEqual(history.slice(0, 3), ['pending:applicant', 'viewed:agent', 'shortlisted:agent']);
  assert.ok(history.includes('hired:applicant'));

  // Employer's own job: joining confirmed by the hiring organization itself.
  const empJob = await model('Job').findOne({ title: 'Physics Teacher' });
  expect(await api('Teacher', 'POST', `/jobs/${empJob._id}/apply`, {}), 201);
  const tApp = await model('JobApplication').findOne({ job: empJob._id });
  const h = await api('Employer', 'PATCH', `/jobs/applications/${tApp._id}/status`, { status: 'hired' });
  assert.equal(h.body.data.joining.via, 'hiring_organization');
  assert.equal(await model('Commission').countDocuments({ application: tApp._id }), 0, 'no agent commission on an employer job');
  expect(await api('Teacher', 'POST', `/jobs/applications/${tApp._id}/withdraw`), 409, 'cannot withdraw after joining');
});

test('applicants can withdraw before joining', async () => {
  const j = await model('Job').findOne({ title: 'Accountant' });
  expect(await api('Alerted', 'POST', `/jobs/${j._id}/apply`, {}), 201);
  const a = await model('JobApplication').findOne({ job: j._id, applicant: u.Alerted._id });
  expect(await api('Alerted', 'POST', `/jobs/applications/${a._id}/withdraw`, { reason: 'Took another offer' }), 200);
  assert.equal((await model('JobApplication').findById(a._id)).status, 'withdrawn');
});

test('scholarship alerts reach the right audience once; decisions are emailed', async () => {
  const r = await api('Donor', 'POST', '/scholarships', { title: 'Computer Science Merit Grant', amount: 50000, currency: 'PKR', country: 'PK', eligibilityCriteria: 'BS Computer Science students with CGPA 3.0+', seatsAvailable: 2 });
  expect(r, 201);
  const sid = r.body.data._id;
  const sch = await notes('Skilled', { category: 'scholarship_alert' });
  assert.equal(sch.length, 1);
  assert.equal(sch[0].link, `/scholarships/${sid}`);
  assert.match(sch[0].body, /mentions computer science/);
  assert.equal((await notes('Abroad', { category: 'scholarship_alert' })).length, 0, 'other country');
  assert.equal((await notes('Teacher', { category: 'scholarship_alert' })).length, 0, 'students only by default');
  await api('Donor', 'POST', '/scholarships', { title: 'Teacher Research Fund', amount: 80000, currency: 'PKR', country: 'PK', audience: ['teachers'] });
  assert.equal((await notes('Teacher', { category: 'scholarship_alert' })).length, 1);
  assert.equal((await notes('Skilled', { category: 'scholarship_alert' })).length, 1, 'teacher-only fund not sent to students');
  expect(await api('Skilled', 'POST', `/scholarships/${sid}/apply`, { statement: 'I study CS with a 3.6 CGPA.' }), 201);
  const appl = await model('ScholarshipApplication').findOne({ scholarship: sid });
  emails.length = 0;
  const d = await api('Donor', 'PATCH', `/scholarships/applications/${appl._id}/status`, { status: 'approved' });
  assert.ok([200, 201].includes(d.status), d.text);
  assert.ok(emailsTo('Skilled').some((e) => /Approved/.test(e.subject)));
});
