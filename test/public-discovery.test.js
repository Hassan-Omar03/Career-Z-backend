const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Public homepage and View All pages: only approved, active, unexpired content from approved and
// active publishers is shown; no private fields leak; filters and counts are real database
// queries; donors appear only by choice; applying enforces account type, deadline and seats.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const listings = require('../src/services/publicListings.service');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 300)}`);
async function account(name, role, { approved = true, status = 'active' } = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@public.test`, passwordHash: 'x', emailVerified: true, roles: [role], status, city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending_approval' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Agent', 'education_agent');
  await account('PendingAgent', 'education_agent', { approved: false });
  await account('SuspendedAgent', 'education_agent', { status: 'suspended' });
  await account('Donor', 'donor');
  await account('QuietDonor', 'donor');
  await account('Seller', 'marketplace_seller');
  await account('Owner', 'institution_owner');
  await account('Student', 'student');
  await account('Parent', 'parent');
  const future = new Date(Date.now() + 20 * 864e5);
  S.job = await model('Job').create({ postedBy: u.Agent._id, title: 'Data Analyst', company: 'Insight Co', country: 'PK', city: 'Lahore', type: 'full_time', salaryMin: 90000, salaryMax: 150000, currency: 'PKR', experienceYears: 2, applicationDeadline: future, contactEmail: 'hr-secret@insight.test', contactPhone: '0300-0000000', skills: ['SQL'] });
  await model('Job').create({ postedBy: u.Agent._id, title: 'Remote React Intern', company: 'Web Co', country: 'PK', city: 'Karachi', type: 'internship', workMode: 'remote', applicationDeadline: future });
  S.expired = await model('Job').create({ postedBy: u.Agent._id, title: 'Expired Role', company: 'Old Co', country: 'PK', applicationDeadline: new Date('2020-01-01') });
  await model('Job').create({ postedBy: u.Agent._id, title: 'Closed Role', company: 'Shut Co', country: 'PK', status: 'closed' });
  await model('Job').create({ postedBy: u.PendingAgent._id, title: 'Unapproved Agent Job', company: 'X', country: 'PK' });
  S.suspendedJob = await model('Job').create({ postedBy: u.SuspendedAgent._id, title: 'Suspended Agent Job', company: 'Y', country: 'PK' });
  S.scholarship = await model('Scholarship').create({ donor: u.Donor._id, title: 'Women in STEM Grant', amount: 200000, currency: 'PKR', country: 'PK', seatsAvailable: 2, applicationDeadline: future, eligibilityCriteria: 'BS students' });
  S.fullScholarship = await model('Scholarship').create({ donor: u.Donor._id, title: 'Full Grant', amount: 1000, seatsAvailable: 0 });
  S.lateScholarship = await model('Scholarship').create({ donor: u.Donor._id, title: 'Late Grant', amount: 1000, applicationDeadline: new Date('2020-01-01') });
  await model('Product').create({ seller: u.Seller._id, title: 'Physics Textbook', category: 'books', price: 1500, currency: 'PKR', stock: 3, status: 'active' });
  await model('Product').create({ seller: u.Seller._id, title: 'Pending Calculator', category: 'electronics', price: 900, stock: 2, status: 'pending_approval' });
  S.school = await model('Institution').create({ name: 'GCUF', slug: 'gcuf', type: 'university', country: 'PAKISTAN', city: 'Faisalabad', owner: u.Owner._id, verificationStatus: 'approved', description: 'Public university' });
  await model('Institution').create({ name: 'Unverified Academy', slug: 'unverified', type: 'academy', country: 'PK', owner: u.Owner._id, verificationStatus: 'pending' });
  await model('DonorPublicProfile').create({ user: u.QuietDonor._id, enabled: false, displayName: 'Quiet Trust' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('homepage shows only live, approved content from approved, active publishers; counts match', async () => {
  const r = await api(null, 'GET', '/public/home');
  expect(r, 200, 'home without login');
  const d = r.body.data;
  assert.deepEqual(d.jobs.map((j) => j.title).sort(), ['Data Analyst', 'Remote React Intern']);
  assert.deepEqual(d.scholarships.map((s) => s.title), ['Women in STEM Grant']);
  assert.deepEqual(d.marketplace.map((p) => p.title), ['Physics Textbook']);
  assert.deepEqual(d.institutes.map((i) => i.name), ['GCUF']);
  assert.deepEqual(d.donors, [], 'donors are hidden until they opt in');
  assert.deepEqual([d.stats.activeJobs, d.stats.activeScholarships, d.stats.approvedInstitutes, d.stats.activeMarketplaceListings, d.stats.publicDonors], [2, 1, 1, 1, 0]);
  const raw = JSON.stringify(r.body);
  for (const secret of ['public.test', 'hr-secret', '0300-0000000', 'passwordHash']) assert.ok(!raw.includes(secret), `public data must not include ${secret}`);
  assert.equal(d.scholarships[0].provider.name, 'Verified donor', 'donor name hidden without a public profile');
});

test('View All pages filter and page on the server', async () => {
  let r = await api(null, 'GET', '/public/jobs?type=internship');
  assert.deepEqual(r.body.data.items.map((j) => j.title), ['Remote React Intern']);
  r = await api(null, 'GET', '/public/jobs?q=analyst&city=lah');
  assert.deepEqual(r.body.data.items.map((j) => j.title), ['Data Analyst']);
  r = await api(null, 'GET', '/public/jobs?minSalary=100000');
  assert.deepEqual(r.body.data.items.map((j) => j.title), ['Data Analyst']);
  r = await api(null, 'GET', '/public/jobs?limit=1&page=2');
  assert.deepEqual([r.body.data.total, r.body.data.pages, r.body.data.items.length], [2, 2, 1]);
  for (const q of ['a.(b', '[', '*']) expect(await api(null, 'GET', `/public/jobs?q=${encodeURIComponent(q)}&city=${encodeURIComponent(q)}`), 200, `search ${q}`);
  r = await api(null, 'GET', '/public/institutes?country=pakistan&type=university');
  assert.equal(r.body.data.total, 1);
  r = await api(null, 'GET', '/public/marketplace?category=electronics');
  assert.equal(r.body.data.total, 0, 'unapproved listing stays hidden');
});

test('detail pages: live records open, hidden ones are 404', async () => {
  let r = await api(null, 'GET', `/public/jobs/${S.job._id}`);
  expect(r, 200);
  assert.equal(r.body.data.postedBy.kind, 'agent');
  assert.ok(!JSON.stringify(r.body).includes('hr-secret'));
  for (const id of [S.expired._id, S.suspendedJob._id, 'not-an-id']) expect(await api(null, 'GET', `/public/jobs/${id}`), 404, `hidden job ${id}`);
  r = await api(null, 'GET', `/public/institutes/${S.school._id}`);
  expect(r, 200, 'institute profile');
  assert.equal(r.body.data.name, 'GCUF');
  expect(await api(null, 'GET', `/public/scholarships/${S.fullScholarship._id}`), 404, 'no seats left');
});

test('donors appear only after switching their public profile on', async () => {
  expect(await api('Student', 'PUT', '/public/me/donor-profile', { enabled: true, displayName: 'X' }), 403, 'only donors');
  expect(await api('Donor', 'PUT', '/public/me/donor-profile', { enabled: true, displayName: '' }), 422, 'needs a public name');
  const r = await api('Donor', 'PUT', '/public/me/donor-profile', { enabled: true, displayName: 'Hope Foundation', about: 'STEM grants', focusAreas: 'STEM, Girls education', logoUrl: 'http://insecure.example/logo.png' });
  expect(r, 422, 'https logo only');
  expect(await api('Donor', 'PUT', '/public/me/donor-profile', { enabled: true, displayName: 'Hope Foundation', about: 'STEM grants', focusAreas: 'STEM, Girls education' }), 200);
  listings.resetStatsCache();
  const home = (await api(null, 'GET', '/public/home')).body.data;
  assert.deepEqual(home.donors.map((d) => [d.name, d.openScholarships, d.focusAreas.length]), [['Hope Foundation', 1, 2]]);
  assert.equal(home.stats.publicDonors, 1);
  assert.deepEqual(home.scholarships[0].provider, { name: 'Hope Foundation', profile: `/donors/${u.Donor._id}` });
  const profile = await api(null, 'GET', `/public/donors/${u.Donor._id}`);
  assert.deepEqual(profile.body.data.scholarships.map((s) => s.title), ['Women in STEM Grant']);
  expect(await api(null, 'GET', `/public/donors/${u.QuietDonor._id}`), 404, 'opted-out donor stays private');
});

test('applying: right account type only, deadlines and seats enforced, no duplicates', async () => {
  let r = await api('Parent', 'POST', `/jobs/${S.job._id}/apply`, {});
  expect(r, 403, 'parent cannot apply for a job');
  assert.match(r.body.message, /student or teacher/);
  expect(await api('Student', 'POST', `/jobs/${S.job._id}/apply`, { coverLetter: 'Hi' }), 201, 'student applies');
  expect(await api('Student', 'POST', `/jobs/${S.job._id}/apply`, {}), 409, 'duplicate');
  expect(await api('Student', 'POST', `/jobs/${S.suspendedJob._id}/apply`, {}), 400, 'publisher suspended');
  expect(await api('Parent', 'POST', `/scholarships/${S.scholarship._id}/apply`, { statement: 'x' }), 403, 'scholarships are for students');
  expect(await api('Student', 'POST', `/scholarships/${S.lateScholarship._id}/apply`, { statement: 'x' }), 400, 'deadline passed');
  expect(await api('Student', 'POST', `/scholarships/${S.fullScholarship._id}/apply`, { statement: 'x' }), 400, 'no seats');
  expect(await api('Student', 'POST', `/scholarships/${S.scholarship._id}/apply`, { statement: 'I study CS' }), 201, 'student applies');
  const mine = await api('Student', 'GET', '/jobs/mine/applications').catch(() => null);
  assert.ok(await model('JobApplication').exists({ job: S.job._id, applicant: u.Student._id }));
});
