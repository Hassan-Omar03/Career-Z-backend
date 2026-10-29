const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Employer system (master Part 12): job post extras, AI Job Builder, and the rest of the
// employer features as they are built.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const ai = require('../src/services/ai.service');
let aiReply = '{}';
mock.method(ai, 'generate', async () => aiReply);
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
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@empsys.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const jobBody = (extra = {}) => ({ title: 'English Teacher', company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Teach English to O-level classes at our Lahore campus. B.A. English and two years of teaching required.', ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Cand', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('job post: vacancies, gender and age range are checked and saved; interview questions stay private', async () => {
  expect(await api('Employer', 'POST', '/jobs', jobBody({ vacancies: 0 })), 422, 'vacancies >= 1');
  expect(await api('Employer', 'POST', '/jobs', jobBody({ genderPreference: 'other' })), 422);
  expect(await api('Employer', 'POST', '/jobs', jobBody({ ageMin: 40, ageMax: 30 })), 422, 'min > max');
  expect(await api('Employer', 'POST', '/jobs', jobBody({ ageMin: 10 })), 422, 'too young');
  const r = await api('Employer', 'POST', '/jobs', jobBody({ vacancies: 3, genderPreference: 'female', ageMin: 22, ageMax: 40, interviewQuestions: ['How do you teach tenses?', ' ', 'Describe a weak student you helped.'] }));
  expect(r, 201);
  S.job = r.body.data._id;
  const doc = await model('Job').findById(S.job).select('+interviewQuestions').lean();
  assert.equal(doc.vacancies, 3);
  assert.equal(doc.genderPreference, 'female');
  assert.deepEqual([doc.ageMin, doc.ageMax], [22, 40]);
  assert.deepEqual(doc.interviewQuestions, ['How do you teach tenses?', 'Describe a weak student you helped.']);
  const pub = await api(null, 'GET', `/jobs/${S.job}`);
  expect(pub, 200);
  const shown = pub.body.data.job || pub.body.data;
  assert.equal(shown.interviewQuestions, undefined, 'interview questions are never public');
  assert.equal(shown.vacancies, 3);
  const mine = await api('Employer', 'GET', '/jobs/mine/list');
  assert.deepEqual(mine.body.data.find((j) => j._id === S.job).interviewQuestions.length, 2, 'the employer still sees them');
});

test('AI Job Builder turns one line into a reviewed draft with market facts', async () => {
  expect(await api('Employer', 'POST', '/jobs/ai/build-job', { brief: 'hi' }), 422, 'one real line needed');
  aiReply = 'Sure: {"title":"English Teacher (O-levels)","category":"teaching","description":"About the role\\n- Teach English","skills":["grammar","literature"],"experienceYears":2,"education":"B.A. English","interviewQuestions":["How do you plan a lesson?"],"salarySuggestion":{"min":55000,"max":80000,"currency":"pkr","note":"Lahore range"},"marketAnalysis":"Steady demand."}';
  const r = await api('Employer', 'POST', '/jobs/ai/build-job', { brief: 'Need English Teacher', country: 'PK', city: 'Lahore' });
  expect(r, 200);
  const d = r.body.data;
  assert.equal(d.title, 'English Teacher (O-levels)');
  assert.deepEqual(d.skills, ['grammar', 'literature']);
  assert.deepEqual(d.interviewQuestions, ['How do you plan a lesson?']);
  assert.equal(d.salarySuggestion.currency, 'PKR');
  assert.equal(d.salarySuggestion.min, 55000);
  assert.ok(d.market.count >= 1, 'counts the earlier English Teacher job');
  aiReply = 'no json here';
  expect(await api('Employer', 'POST', '/jobs/ai/build-job', { brief: 'Need English Teacher' }), 502);
});

test('accepting an offer needs a typed digital signature, stored with time and device', async () => {
  S.app = (await api('Cand', 'POST', `/jobs/${S.job}/apply`, {})).body.data._id;
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 70000, currency: 'PKR', startDate: '2026-12-01', expiresAt: '2027-01-15' }), 200);
  const emp = await model('Employment').findOne({ application: S.app });
  expect(await api('Cand', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted' }), 422, 'no signature');
  expect(await api('Cand', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted', signedName: ' a ' }), 422, 'too short');
  expect(await api('Cand', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted', signedName: '  Cand   Person ' }), 200);
  const signed = await model('Employment').findById(emp._id).lean();
  assert.equal(signed.status, 'accepted');
  assert.equal(signed.signature.name, 'Cand Person');
  assert.ok(signed.signature.at);
});

test('company staff: invite by email, accept, then act only within their permissions', async () => {
  await account('Recruiter', 'student');
  await account('Finance', 'teacher');
  expect(await api('Cand', 'POST', '/employer-staff', { email: 'recruiter@empsys.test', role: 'recruiter' }), 403, 'only a verified employer');
  expect(await api('Employer', 'POST', '/employer-staff', { email: 'nobody@empsys.test', role: 'recruiter' }), 404);
  expect(await api('Employer', 'POST', '/employer-staff', { email: 'recruiter@empsys.test', role: 'boss' }), 422);
  const inv = await api('Employer', 'POST', '/employer-staff', { email: 'recruiter@empsys.test', role: 'recruiter' });
  expect(inv, 200);
  assert.deepEqual(inv.body.data.permissions, ['post_jobs', 'manage_applicants']);
  expect(await api('Employer', 'POST', '/employer-staff', { email: 'recruiter@empsys.test', role: 'hr' }), 409, 'already listed');
  const fin = await api('Employer', 'POST', '/employer-staff', { email: 'finance@empsys.test', role: 'finance' });
  const emp = String(u.Employer._id);

  // Before accepting, nothing works.
  expect(await api('Recruiter', 'GET', `/jobs/mine/list?employer=${emp}`), 403, 'invite not accepted yet');
  const mine = await api('Recruiter', 'GET', '/employer-staff/mine/companies');
  assert.equal(mine.body.data[0].employer.fullName, 'Employer');
  expect(await api('Recruiter', 'PATCH', `/employer-staff/mine/${inv.body.data._id}/respond`, { decision: 'accepted' }), 200);
  expect(await api('Finance', 'PATCH', `/employer-staff/mine/${fin.body.data._id}/respond`, { decision: 'accepted' }), 200);

  // Recruiter posts in the employer's name and manages applicants, but cannot make offers.
  const posted = await api('Recruiter', 'POST', '/jobs', jobBody({ title: 'Maths Teacher', employer: emp }));
  expect(posted, 201);
  assert.equal(String(posted.body.data.postedBy), emp, 'the job belongs to the employer');
  const list = await api('Recruiter', 'GET', `/jobs/mine/list?employer=${emp}`);
  assert.ok(list.body.data.some((j) => j._id === posted.body.data._id));
  expect(await api('Recruiter', 'PATCH', `/jobs/${posted.body.data._id}`, { city: 'Karachi' }), 200);
  const appId = (await api('Cand', 'POST', `/jobs/${posted.body.data._id}/apply`, {})).body.data._id;
  expect(await api('Recruiter', 'GET', `/jobs/${posted.body.data._id}/applicants`), 200);
  expect(await api('Recruiter', 'PATCH', `/jobs/applications/${appId}/status`, { status: 'shortlisted' }), 200);
  expect(await api('Recruiter', 'POST', `/jobs/applications/${appId}/offer`, { salary: 50000, currency: 'PKR', startDate: '2026-12-01', expiresAt: '2027-01-15' }), 403, 'no make_offers');
  expect(await api('Recruiter', 'GET', `/jobs/mine/summary?employer=${emp}`), 403, 'no view_reports');
  expect(await api('Recruiter', 'GET', `/employment/posted?employer=${emp}`), 403, 'no manage_employees');

  // Finance sees reports only; cannot post or touch applicants.
  const sum = await api('Finance', 'GET', `/jobs/mine/summary?employer=${emp}`);
  expect(sum, 200);
  assert.ok(sum.body.data.activeJobPosts >= 1);
  expect(await api('Finance', 'POST', '/jobs', jobBody({ employer: emp })), 403);
  expect(await api('Finance', 'GET', `/jobs/${posted.body.data._id}/applicants`), 403);

  // The employer widens the recruiter to make offers, then removes them; access ends.
  expect(await api('Employer', 'PATCH', `/employer-staff/${inv.body.data._id}`, { permissions: ['post_jobs', 'manage_applicants', 'make_offers'] }), 200);
  expect(await api('Recruiter', 'POST', `/jobs/applications/${appId}/offer`, { salary: 50000, currency: 'PKR', startDate: '2026-12-01', expiresAt: '2027-01-15' }), 200);
  expect(await api('Employer', 'DELETE', `/employer-staff/${inv.body.data._id}`), 200);
  expect(await api('Recruiter', 'GET', `/jobs/mine/list?employer=${emp}`), 403, 'removed');
  expect(await api('Recruiter', 'PATCH', `/jobs/${posted.body.data._id}`, { city: 'Lahore' }), 403);
});

test('employee reviews: only real employees, fake-review checks, employer answer/report, admin decision and one appeal; trust score', async () => {
  await account('Boss', 'super_admin');
  const emp = await model('Employment').findOne({ application: S.app });
  expect(await api('Cand', 'POST', '/employer-trust/reviews', { employment: emp._id, rating: 4, comment: 'Good place to work, kind seniors.' }), 409, 'offer accepted but not joined yet');
  await model('Employment').updateOne({ _id: emp._id }, { $set: { status: 'active', startDate: new Date(Date.now() - 60 * 864e5) } });
  expect(await api('Employer', 'POST', '/employer-trust/reviews', { employment: emp._id, rating: 5, comment: 'Best company ever!!' }), 404, 'not the employee');
  const reviewable = await api('Cand', 'GET', '/employer-trust/reviews/reviewable');
  assert.equal(reviewable.body.data.length, 1);

  // A brand-new account is held for evidence review.
  const held = await api('Cand', 'POST', '/employer-trust/reviews', { employment: emp._id, rating: 2, comment: 'Salary came late twice, call me on 0300 1234567', salaryOnTime: false });
  expect(held, 200);
  assert.equal(held.body.data.status, 'pending');
  assert.ok(held.body.data.flags.some((f) => f.code === 'new_account'));
  assert.ok(held.body.data.flags.some((f) => f.code === 'contact_or_link'));
  expect(await api('Cand', 'POST', '/employer-trust/reviews', { employment: emp._id, rating: 3, comment: 'Second try at a review.' }), 409, 'one per employment');
  let pub = await api(null, 'GET', `/employer-trust/companies/${u.Employer._id}`);
  assert.equal(pub.body.data.reviews.length, 0, 'held reviews are not public');

  // Admin hides it; the reviewer appeals once; admin upholds and it is published.
  const queue = await api('Boss', 'GET', '/employer-trust/admin/reviews');
  assert.equal(queue.body.data.length, 1);
  const id = held.body.data._id;
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/reviews/${id}`, { status: 'hidden', note: 'Contains a phone number.' }), 200);
  expect(await api('Cand', 'POST', `/employer-trust/reviews/${id}/appeal`, { text: 'The salary part is true, I have payslips.' }), 200);
  expect(await api('Cand', 'POST', `/employer-trust/reviews/${id}/appeal`, { text: 'Second appeal attempt here.' }), 409, 'only once');
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/reviews/${id}/appeal`, { upheld: true, note: 'Payslips checked.' }), 200);
  pub = await api(null, 'GET', `/employer-trust/companies/${u.Employer._id}`);
  assert.equal(pub.body.data.reviews.length, 1);
  assert.equal(pub.body.data.reviews[0].reviewer, 'Verified employee', 'reviewer identity stays private');
  assert.equal(pub.body.data.reviews[0].jobTitle, 'English Teacher');

  // Employer answers and reports; admin keeps it; the single appeal is already used.
  expect(await api('Employer', 'PATCH', `/employer-trust/reviews/${id}/respond`, { text: 'Salaries are now paid on the 1st.' }), 200);
  expect(await api('Employer', 'POST', `/employer-trust/reviews/${id}/report`, { reason: 'This employee was paid on time every month.' }), 200);
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/reviews/${id}`, { status: 'published', note: 'Evidence supports the review.' }), 200);
  expect(await api('Employer', 'POST', `/employer-trust/reviews/${id}/appeal`, { text: 'Bank statements attached by email.' }), 409, 'already appealed once by the reviewer');

  // Trust score: verified, satisfaction 2/5, salary not on time, no fraud.
  const trust = (await api(null, 'GET', `/employer-trust/companies/${u.Employer._id}`)).body.data.trust;
  const f = Object.fromEntries(trust.factors.map((x) => [x.key, x]));
  assert.equal(f.verified.points, 20);
  assert.equal(f.satisfaction.points, 8);
  assert.equal(f.onTimeSalary.points, 0);
  assert.equal(f.scamFree.points, 15);
  assert.ok(trust.score > 0 && trust.score < 100);
});

test('fraud protection: report with evidence, warning then suspension then ban, evidence archive and authority record', async () => {
  const emp = String(u.Employer._id);
  expect(await api('Employer', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'fake_job', description: 'Reporting my own company for testing.' }), 422, 'not yourself');
  expect(await api('Cand', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'bogus', description: 'They asked me to pay a visa fee first.' }), 422);
  const r1 = await api('Cand', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'salary_scam', job: S.job, description: 'They asked me to pay a training fee before joining.', evidence: 'Screenshot of WhatsApp message asking Rs 5000.' });
  expect(r1, 200);
  expect(await api('Cand', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'fake_job', description: 'Another report while one is open.' }), 409);
  expect(await api('Cand', 'POST', `/employer-trust/fraud-reports/${r1.body.data._id}/evidence`, { note: 'Bank slip of the fee paid.' }), 200);
  expect(await api('Recruiter', 'POST', `/employer-trust/fraud-reports/${r1.body.data._id}/evidence`, { note: 'Not my report at all.' }), 404);

  const ov = await api('Boss', 'GET', '/employer-trust/admin/overview');
  assert.equal(ov.body.data.openFraud, 1);
  assert.ok(ov.body.data.totalEmployers >= 1);
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/fraud-cases/${r1.body.data._id}`, { action: 'next' }), 422, 'reason needed');
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/fraud-cases/${r1.body.data._id}`, { action: 'next', note: 'Asked candidate for money.' }), 200);
  assert.equal((await model('User').findById(emp).lean()).employerSanctions.level, 'warning');
  expect(await api('Boss', 'POST', `/employer-trust/admin/fraud-cases/${r1.body.data._id}/authority-report`, { authority: 'FIA Cyber Crime', note: 'Case file shared.' }), 422, 'must confirm the law allows it');
  expect(await api('Boss', 'POST', `/employer-trust/admin/fraud-cases/${r1.body.data._id}/authority-report`, { authority: 'FIA Cyber Crime', note: 'Case file shared.', lawAllows: true }), 200);

  // Second report: suspension. Posting blocked, live jobs paused.
  const r2 = await api('Recruiter', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'fake_interview', description: 'Interview link was a phishing page asking for my CNIC.' });
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/fraud-cases/${r2.body.data._id}`, { action: 'next', days: 10, note: 'Phishing interview link.' }), 200);
  assert.equal((await model('Job').findById(S.job).lean()).status, 'paused');
  expect(await api('Employer', 'POST', '/jobs', jobBody({ title: 'Science Teacher' })), 403, 'suspended');
  expect(await api('Employer', 'PATCH', `/jobs/${S.job}`, { status: 'active' }), 403, 'cannot re-open while suspended');
  const trust = (await api(null, 'GET', `/employer-trust/companies/${emp}`)).body.data.trust;
  assert.equal(trust.factors.find((x) => x.key === 'scamFree').points, 0);

  // Third: permanent ban. Role removed, jobs closed, cases archived.
  const r3 = await api('Finance', 'POST', `/employer-trust/companies/${emp}/fraud-reports`, { category: 'identity_fraud', description: 'The company documents belong to a different firm.' });
  expect(await api('Boss', 'PATCH', `/employer-trust/admin/fraud-cases/${r3.body.data._id}`, { action: 'next', note: 'Forged company papers.' }), 200);
  const banned = await model('User').findById(emp).lean();
  assert.equal(banned.employerSanctions.level, 'banned');
  assert.ok(!banned.roles.includes('employer'));
  assert.equal((await model('Job').findById(S.job).lean()).status, 'closed');
  const archive = await api('Boss', 'GET', '/employer-trust/admin/fraud-cases?status=archive');
  assert.equal(archive.body.data.length, 3);
  assert.equal(archive.body.data.find((c) => c._id === r1.body.data._id).evidence.length, 2, 'evidence kept');
  expect(await api('Boss', 'POST', `/employer-trust/admin/employers/${emp}/lift`, { note: 'x' }), 409, 'a ban is not lifted here');
});
