const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Master 4.24 (only verified organizations post jobs), 5.5 (institute owner hires staff), 6.8 /
// 12.2 (employer verification, startup mode) and 12.5 (submit → auto check → risk scan →
// publish, admin review when needed): who may post, institute jobs, the risk scan, the admin
// review queue and what the public can see.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (user, payload) => { sent.push({ user: String(user), ...payload }); return {}; });
mock.method(notifications, 'notifyAdmins', async (payload) => { sent.push({ admins: true, ...payload }); });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${tok(u[who])}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${JSON.stringify(res.body).slice(0, 400)}`);
async function account(name, role, { approved = true, subtype = '', approvedAt = new Date(Date.now() - 30 * 864e5) } = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@jobs.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending_approval', subtype, approvedAt: approved ? approvedAt : null });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const goodJob = (extra = {}) => ({ title: 'Mathematics Teacher', company: 'ignored for institutes', country: 'PK', city: 'Faisalabad', category: 'teaching', type: 'full_time', salaryMin: 60000, salaryMax: 90000, currency: 'PKR', description: 'Teach mathematics to grade 9 and 10 students. B.Ed and two years of classroom experience required.', skills: ['mathematics'], ...extra });

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution_owner');
  await account('HR', 'teacher');
  await account('Clerk', 'teacher');
  await account('Employer', 'employer', { subtype: 'company' });
  await account('Startup', 'employer', { subtype: 'startup' });
  await account('PendingEmployer', 'employer', { approved: false, subtype: 'company' });
  await account('Agent', 'education_agent', { subtype: 'individual' });
  await account('Student', 'student');
  u.Admin = await model('User').create({ fullName: 'Admin', email: 'admin@jobs.test', passwordHash: 'x', emailVerified: true, roles: ['super_admin'], status: 'active' });
  S.inst = await model('Institution').create({ name: 'GCUF', slug: 'gcuf', type: 'university', country: 'PK', city: 'Faisalabad', owner: u.Owner._id, verificationStatus: 'approved', logo: 'https://cdn.test/gcuf.png',
    staff: [{ user: u.HR._id, role: 'hr_manager', permissions: ['staff:review', 'recruitment:manage'] }, { user: u.Clerk._id, role: 'staff', permissions: [] }] });
  S.unverified = await model('Institution').create({ name: 'New School', slug: 'new-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'pending' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('a verified institute posts its own job directly; it goes live under the institute name', async () => {
  const r = await api('Owner', 'POST', '/jobs', goodJob({ institution: S.inst._id }));
  expect(r, 201, 'institute post');
  assert.equal(r.body.data.outcome.published, true);
  assert.equal(r.body.data.company, 'GCUF', 'company is always the institute');
  assert.equal(r.body.data.companyLogo, 'https://cdn.test/gcuf.png');
  S.instJob = r.body.data._id;
  const pub = await api(null, 'GET', '/public/jobs?category=teaching');
  expect(pub, 200);
  assert.deepEqual(pub.body.data.items.map((j) => [j.title, j.postedBy.kind]), [['Mathematics Teacher', 'institute']]);
  const page = await api(null, 'GET', `/public/institutes/${S.inst._id}`);
  assert.deepEqual(page.body.data.jobs.map((j) => j.title), ['Mathematics Teacher']);
  assert.ok((await model('Job').findById(S.instJob)).publishedAt, 'published once');
});

test('who may post: recruitment staff yes; other staff, students, unverified employers and unverified institutes no', async () => {
  expect(await api('HR', 'POST', '/jobs', goodJob({ title: 'Hostel Warden', category: 'hostel', institution: S.inst._id })), 201, 'HR manager with recruitment:manage');
  expect(await api('Clerk', 'POST', '/jobs', goodJob({ title: 'Driver', category: 'transport', institution: S.inst._id })), 403, 'staff without permission');
  expect(await api('Student', 'POST', '/jobs', goodJob()), 403, 'student');
  expect(await api('PendingEmployer', 'POST', '/jobs', goodJob()), 403, 'employer pending verification');
  expect(await api('Owner', 'POST', '/jobs', goodJob({ institution: S.unverified._id })), 403, 'unverified institute');
  expect(await api('Employer', 'POST', '/jobs', goodJob({ title: 'Accountant', institution: S.inst._id })), 403, 'employer cannot post for an institute');
  const emp = await api('Employer', 'POST', '/jobs', goodJob({ title: 'Data Analyst', company: 'Insight Co', category: 'it_technical' }));
  expect(emp, 201, 'verified employer');
  assert.equal(emp.body.data.institution, null);
  assert.equal(emp.body.data.company, 'Insight Co');
});

test('risk scan holds suspicious jobs for admin review; they stay hidden until approved', async () => {
  const risky = await api('Agent', 'POST', '/jobs', goodJob({ title: 'Office Assistant Dubai', company: 'Gulf Jobs', description: 'Guaranteed visa! Pay registration fee of Rs 15000 to apply. WhatsApp 0300 1234567 now.' }));
  expect(risky, 201);
  assert.equal(risky.body.data.status, 'pending_review');
  assert.equal(risky.body.data.outcome.published, false);
  assert.ok(risky.body.data.outcome.flags.some((f) => f.code === 'asks_for_money'));
  assert.ok(sent.some((n) => n.admins && /waiting for review/.test(n.title)), 'admins told');
  const id = risky.body.data._id;
  expect(await api(null, 'GET', `/jobs/${id}`), 404, 'public cannot open a held job');
  expect(await api('Student', 'GET', `/jobs/${id}`), 404);
  expect(await api('Agent', 'GET', `/jobs/${id}`), 200, 'publisher can');
  assert.ok(!(await api(null, 'GET', '/public/jobs')).body.data.items.some((j) => j._id === id));

  const queue = await api('Admin', 'GET', '/admin/jobs/review');
  expect(queue, 200);
  assert.deepEqual(queue.body.data.map((j) => j._id), [id]);
  expect(await api('Admin', 'POST', `/admin/jobs/${id}/decision`, { decision: 'reject' }), 422, 'reject needs a reason');
  expect(await api('Admin', 'POST', `/admin/jobs/${id}/decision`, { decision: 'reject', note: 'Asks for a registration fee.' }), 200);
  assert.equal((await model('Job').findById(id)).status, 'rejected');
  assert.ok(sent.some((n) => n.user === String(u.Agent._id) && /not approved/.test(n.title) && /registration fee/.test(n.body)));

  // Publisher fixes it and resubmits; a clean job goes live.
  const fixed = await api('Agent', 'PATCH', `/jobs/${id}`, { description: 'Office assistant for a trading company. Interviews in Lahore; no fees are charged to applicants at any stage.', status: 'active' });
  expect(fixed, 200);
  assert.equal(fixed.body.data.status, 'active');
  assert.ok((await api(null, 'GET', '/public/jobs')).body.data.items.some((j) => j._id === id));
});

test('admin approval publishes a held job; startup employers and duplicates are held', async () => {
  const startup = await api('Startup', 'POST', '/jobs', goodJob({ title: 'Junior Designer', company: 'Pixel Startup', category: 'sales_marketing' }));
  assert.equal(startup.body.data.status, 'pending_review');
  assert.ok(startup.body.data.outcome.flags.some((f) => f.code === 'startup_employer'));
  expect(await api('Admin', 'POST', `/admin/jobs/${startup.body.data._id}/decision`, { decision: 'approve' }), 200);
  const job = await model('Job').findById(startup.body.data._id);
  assert.equal(job.status, 'active');
  assert.ok(job.publishedAt);
  expect(await api('Admin', 'POST', `/admin/jobs/${startup.body.data._id}/decision`, { decision: 'approve' }), 409, 'already decided');

  const dup = await api('Employer', 'POST', '/jobs', goodJob({ title: 'Data Analyst', company: 'Insight Co', category: 'it_technical' }));
  assert.equal(dup.body.data.status, 'pending_review');
  assert.ok(dup.body.data.outcome.flags.some((f) => f.code === 'duplicate'));
});

test('editing a live job re-runs the scan; status changes follow the rules', async () => {
  const edit = await api('Owner', 'PATCH', `/jobs/${S.instJob}`, { description: 'Teach maths. Candidates must pay a security deposit of Rs 5000 before joining.' });
  expect(edit, 200);
  assert.equal(edit.body.data.status, 'pending_review', 'edited content goes back to review');
  expect(await api('Owner', 'PATCH', `/jobs/${S.instJob}`, { status: 'paused' }), 409, 'cannot pause a job that is not live');
  const draft = await api('Employer', 'POST', '/jobs', goodJob({ title: 'Receptionist', company: 'Insight Co', status: 'draft', category: 'customer_service' }));
  assert.equal(draft.body.data.status, 'draft');
  expect(await api(null, 'GET', `/jobs/${draft.body.data._id}`), 404, 'drafts are private');
  const live = await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { status: 'active' });
  assert.equal(live.body.data.status, 'active');
  expect(await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { status: 'paused' }), 200);
  expect(await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { status: 'draft' }), 409, 'a published job cannot become a draft');
  expect(await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { status: 'pending_review' }), 422, 'publishers cannot set review states');
  expect(await api('Employer', 'PATCH', `/jobs/${draft.body.data._id}`, { category: 'astronaut' }), 422);
});

test('institute jobs are managed by the owner and recruitment staff only', async () => {
  const warden = await model('Job').findOne({ title: 'Hostel Warden' });
  await model('Resume').create({ user: u.Student._id, skills: ['mathematics'] });
  await model('JobApplication').create({ job: warden._id, applicant: u.Student._id });
  expect(await api('Owner', 'GET', `/jobs/${warden._id}/applicants`), 200, 'owner sees applicants of a job HR posted');
  expect(await api('HR', 'GET', `/jobs/${warden._id}/applicants`), 200);
  expect(await api('Clerk', 'GET', `/jobs/${warden._id}/applicants`), 403);
  expect(await api('Agent', 'GET', `/jobs/${warden._id}/applicants`), 403);
  const mine = await api('Owner', 'GET', `/jobs/mine/list?institution=${S.inst._id}`);
  assert.deepEqual(mine.body.data.map((j) => j.title).sort(), ['Hostel Warden', 'Mathematics Teacher']);
  expect(await api('Agent', 'GET', `/jobs/mine/list?institution=${S.inst._id}`), 403);
  const app = await model('JobApplication').findOne({ job: warden._id });
  expect(await api('HR', 'PATCH', `/jobs/applications/${app._id}/status`, { status: 'shortlisted' }), 200);
  expect(await api('Clerk', 'PATCH', `/jobs/applications/${app._id}/status`, { status: 'rejected' }), 403);
});
