const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Auto timetable (no double-booked class or teacher, spread over the week, preview then apply),
// per-campus reports from real records, the institution assistant's confirm-before-acting
// actions with permission checks, Smart Apply to several jobs, the Perplexity and Local AI
// providers, and the institution's accreditation/affiliation/social/map profile.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
const sent = [];
mock.method(notifications, 'notify', async (user, payload) => { sent.push({ user: String(user), ...payload }); return {}; });
mock.method(notifications, 'notifyMany', async (users, payload) => { for (const u of users) sent.push({ user: String(u), ...payload }); return []; });
mock.method(notifications, 'notifyParentsOfStudent', async (student, payload) => { sent.push({ parentOf: String(student), ...payload }); return []; });
mock.method(notifications, 'notifyAdmins', async () => {});
const ai = require('../src/services/ai.service');
let aiAnswer = '{}';
mock.method(ai, 'generate', async () => aiAnswer);

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
async function account(name, role, extra = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@auto.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', ...extra });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Owner', 'institution_owner');
  await account('Clerk', 'teacher');
  for (const t of ['T1', 'T2']) await account(t, 'teacher');
  for (const s of ['S1', 'S2', 'S3']) await account(s, 'student');
  await account('Parent', 'parent');
  await account('Employer', 'employer');
  S.inst = await model('Institution').create({ name: 'GCUF', slug: 'gcuf', type: 'university', country: 'PK', city: 'Faisalabad', owner: u.Owner._id, verificationStatus: 'approved', address: 'Jail Road', staff: [{ user: u.Clerk._id, role: 'staff', permissions: [] }] });
  S.main = await model('Campus').create({ institution: S.inst._id, name: 'Main Campus', isMain: true });
  S.city = await model('Campus').create({ institution: S.inst._id, name: 'City Campus' });
  S.secA = await model('ClassSection').create({ institution: S.inst._id, name: 'BSCS 1-A', campus: S.main._id });
  S.secB = await model('ClassSection').create({ institution: S.inst._id, name: 'BSCS 1-B', campus: S.city._id });
  const course = (title, sec, teacher, creditHours) => model('Course').create({ title, subject: title, institution: S.inst._id, classSection: sec._id, teacher: teacher._id, creditHours, published: true });
  // T1 teaches in both sections, so the generator must keep T1 in one place at a time.
  S.cA1 = await course('Programming', S.secA, u.T1, 4);
  S.cA2 = await course('Calculus', S.secA, u.T2, 3);
  S.cB1 = await course('Programming B', S.secB, u.T1, 4);
  S.cB2 = await course('Physics', S.secB, u.T2, 3);
  await model('Enrollment').create({ student: u.S1._id, course: S.cA1._id });
  await model('Enrollment').create({ student: u.S2._id, course: S.cB1._id });
  await model('StudentInstitutionMembership').create({ student: u.S3._id, institution: S.inst._id, status: 'active' });
  for (const s of ['S1', 'S2', 'S3']) await model('StudentInstitutionMembership').updateOne({ student: u[s]._id, institution: S.inst._id }, { $set: { status: 'active' } }, { upsert: true });
  await model('ParentChildLink').create({ parent: u.Parent._id, student: u.S1._id, status: 'approved', requestedBy: u.Parent._id });
  const yesterday = new Date(Date.now() - 864e5);
  await model('Fee').create({ student: u.S1._id, institution: S.inst._id, title: 'Tuition', amount: 50000, currency: 'PKR', status: 'pending', dueDate: yesterday, recordedBy: u.Owner._id });
  await model('Fee').create({ student: u.S2._id, institution: S.inst._id, title: 'Tuition', amount: 40000, paidAmount: 40000, currency: 'PKR', status: 'paid', dueDate: yesterday, recordedBy: u.Owner._id });
  S.today = new Date().toISOString().slice(0, 10);
  await model('Attendance').create({ institution: S.inst._id, classSection: S.secA._id, course: S.cA1._id, date: new Date(`${S.today}T09:00:00Z`), markedBy: u.T1._id, records: [{ student: u.S1._id, status: 'absent' }] });
  await model('Attendance').create({ institution: S.inst._id, classSection: S.secB._id, course: S.cB1._id, date: new Date(`${S.today}T09:00:00Z`), markedBy: u.T1._id, records: [{ student: u.S2._id, status: 'present' }] });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

const settings = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], dayStart: '08:00', periodMinutes: 45, periodsPerDay: 4, breakAfter: 2, breakMinutes: 30 };

test('auto timetable: preview places every period without clashes and spreads courses over days', async () => {
  const r = await api('Owner', 'POST', `/institutions/${S.inst._id}/timetable/auto/preview`, { settings });
  expect(r, 200, 'preview');
  const { entries, unplaced, periods } = r.body.data;
  assert.equal(unplaced.length, 0);
  assert.equal(entries.length, 4 + 3 + 4 + 3);
  assert.deepEqual(periods.map((p) => `${p.startTime}-${p.endTime}`), ['08:00-08:45', '08:45-09:30', '10:00-10:45', '10:45-11:30'], 'break after period 2');
  const key = (e, who) => `${who}|${e.dayOfWeek}|${e.startTime}`;
  for (const who of ['classSection', 'teacher']) {
    const seen = new Set();
    for (const e of entries) { assert.ok(!seen.has(key(e, String(e[who]))), `${who} double-booked`); seen.add(key(e, String(e[who]))); }
  }
  const prog = entries.filter((e) => String(e.course) === String(S.cA1._id));
  assert.equal(new Set(prog.map((e) => e.dayOfWeek)).size, 4, 'Programming spread over four days');
  assert.equal(await model('TimetableEntry').countDocuments(), 0, 'preview saves nothing');
});

test('auto timetable: too many periods is refused; staff without permission cannot run it; apply saves and tells teachers', async () => {
  expect(await api('Owner', 'POST', `/institutions/${S.inst._id}/timetable/auto/preview`, { settings: { ...settings, periodsPerDay: 1 } }), 422, 'week too short');
  expect(await api('Clerk', 'POST', `/institutions/${S.inst._id}/timetable/auto/preview`, { settings }), 403, 'no timetable:manage');
  await model('TimetableEntry').create({ institution: S.inst._id, classSection: S.secA._id, subject: 'Old', dayOfWeek: 'sat', startTime: '08:00', endTime: '09:00', createdBy: u.Owner._id });
  sent.length = 0;
  const r = await api('Owner', 'POST', `/institutions/${S.inst._id}/timetable/auto/apply`, { settings });
  expect(r, 200, 'apply');
  assert.equal(r.body.data.saved, 14);
  assert.equal(await model('TimetableEntry').countDocuments({ subject: 'Old' }), 0, 'old slots of those sections replaced');
  assert.equal(await model('TimetableEntry').countDocuments(), 14);
  assert.deepEqual(sent.filter((n) => /new timetable/.test(n.title)).map((n) => n.user).sort(), [String(u.T1._id), String(u.T2._id)].sort());
});

test('per-campus report splits students, attendance and fees by campus', async () => {
  expect(await api('Clerk', 'GET', `/institutions/${S.inst._id}/reports/campuses`), 403);
  const r = await api('Owner', 'GET', `/institutions/${S.inst._id}/reports/campuses`);
  expect(r, 200);
  const by = Object.fromEntries(r.body.data.campuses.map((c) => [c.name, c]));
  assert.equal(by['Main Campus'].students, 1);
  assert.equal(by['City Campus'].students, 1);
  assert.equal(by['Not assigned to a campus'].students, 1, 'member without a section');
  assert.equal(by['Main Campus'].attendance.percent, 0);
  assert.equal(by['City Campus'].attendance.percent, 100);
  assert.deepEqual(by['Main Campus'].fees.PKR, { billed: 50000, collected: 0, outstanding: 50000, overdue: 50000, overdueCount: 1 });
  assert.equal(by['City Campus'].fees.PKR.collected, 40000);
  assert.equal(by['Main Campus'].teachers, 2);
});

test('assistant proposes an action with a preview and acts only when confirmed, within permissions', async () => {
  aiAnswer = JSON.stringify({ action: 'fee_reminders', params: { scope: 'overdue' }, reply: 'I will remind students with overdue fees.' });
  const plan = await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/plan`, { message: 'remind everyone who has not paid' });
  expect(plan, 200, 'plan');
  assert.equal(plan.body.data.action, 'fee_reminders');
  assert.match(plan.body.data.preview.summary, /Remind 1 student/);
  assert.equal(plan.body.data.allowed, true);
  sent.length = 0;
  const run = await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'fee_reminders', params: { scope: 'overdue' } });
  expect(run, 200, 'execute');
  assert.equal(run.body.data.count, 1);
  assert.ok(sent.some((n) => n.user === String(u.S1._id) && /PKR 50,000/.test(n.body)));
  assert.ok(sent.some((n) => n.parentOf === String(u.S1._id)), 'parent told too');

  const absent = await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'absence_alerts', params: { date: S.today } });
  expect(absent, 200);
  assert.equal(absent.body.data.count, 1);

  const ev = await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'create_event', params: { title: 'Sports Day', type: 'sports_day', startDate: '2026-11-20', venue: 'Main ground', audience: ['students'] } });
  expect(ev, 200);
  assert.equal(await model('InstitutionEvent').countDocuments({ title: 'Sports Day' }), 1);
  expect(await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'create_event', params: { title: 'No date' } }), 422);
  expect(await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'delete_everything', params: {} }), 422, 'unknown action');

  await model('Institution').updateOne({ _id: S.inst._id }, { $set: { 'staff.0.permissions': ['ai:use'] } });
  expect(await api('Clerk', 'POST', `/institutions/${S.inst._id}/assistant/execute`, { action: 'fee_reminders', params: {} }), 403, 'ai:use alone cannot send fee reminders');
  aiAnswer = 'not json at all';
  expect(await api('Owner', 'POST', `/institutions/${S.inst._id}/assistant/plan`, { message: 'x' }), 502);
});

test('Smart Apply ranks open jobs by CV match and applies to several under the normal rules', async () => {
  await model('Resume').create({ user: u.S1._id, skills: ['JavaScript', 'React'], experienceLevel: 'entry' });
  const j1 = await model('Job').create({ postedBy: u.Employer._id, title: 'React Intern', company: 'Web Co', country: 'PK', city: 'Lahore', type: 'internship', skills: ['react', 'javascript'] });
  const j2 = await model('Job').create({ postedBy: u.Employer._id, title: 'Accountant', company: 'Ledger', country: 'PK', city: 'Karachi', type: 'full_time', skills: ['excel'], experienceYears: 5 });
  const closed = await model('Job').create({ postedBy: u.Employer._id, title: 'Closed', company: 'X', country: 'PK', status: 'closed' });
  const m = await api('S1', 'GET', '/jobs/smart-apply/matches');
  expect(m, 200);
  assert.equal(m.body.data.jobs[0].title, 'React Intern');
  assert.equal(m.body.data.jobs[0].match.score, 100);
  assert.ok(m.body.data.jobs[1].match.score < 50);
  const r = await api('S1', 'POST', '/jobs/smart-apply', { jobIds: [j1._id, j2._id, closed._id], coverLetter: 'I would love to join {company} as {job}.' });
  expect(r, 200);
  assert.equal(r.body.data.applied, 2);
  assert.equal(r.body.data.results.find((x) => x.title === 'Closed').status, 'skipped');
  assert.equal((await model('JobApplication').findOne({ job: j1._id })).coverLetter, 'I would love to join Web Co as React Intern.');
  const again = await api('S1', 'POST', '/jobs/smart-apply', { jobIds: [j1._id] });
  assert.match(again.body.data.results[0].reason, /already applied/);
  expect(await api('Parent', 'POST', '/jobs/smart-apply', { jobIds: [j2._id] }), 200);
  assert.equal(await model('JobApplication').countDocuments({ applicant: u.Parent._id }), 0, 'parents cannot apply');
  expect(await api('S1', 'POST', '/jobs/smart-apply', { jobIds: [] }), 422);
});

test('Perplexity and Local AI providers: local needs a public address and a model; key optional', async () => {
  expect(await api('Owner', 'PUT', '/ai/config', { purpose: 'text', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' }), 422, 'private address refused');
  expect(await api('Owner', 'PUT', '/ai/config', { purpose: 'text', provider: 'local', baseUrl: 'https://93.184.216.34/v1' }), 422, 'model required');
  expect(await api('Owner', 'PUT', '/ai/config', { purpose: 'text', provider: 'local', baseUrl: 'https://93.184.216.34/v1/', model: 'llama3.1' }), 200, 'saved');
  const cfg = await api('Owner', 'GET', '/ai/config');
  assert.equal(cfg.body.data.text.provider, 'local');
  assert.equal(cfg.body.data.text.baseUrl, 'https://93.184.216.34/v1');
  assert.equal(cfg.body.data.text.keyPreview, 'no key');
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url: String(url), headers: opts.headers }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi from local' } }] }) }; };
  try {
    const cred = await ai.getDecryptedCredential?.(u.Owner._id, 'text');
    const out = await ai.generateWith({ provider: 'local', apiKey: ai.LOCAL_NO_KEY, model: 'llama3.1', baseUrl: 'https://93.184.216.34/v1' }, 'sys', 'user');
    assert.equal(out, 'hi from local');
    assert.equal(calls[0].url, 'https://93.184.216.34/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, undefined, 'no key header when none was given');
    await ai.generateWith({ provider: 'perplexity', apiKey: 'pplx-123456789', model: 'sonar' }, 's', 'u');
    assert.equal(calls[1].url, 'https://api.perplexity.ai/chat/completions');
    void cred;
  } finally { global.fetch = realFetch; }
  expect(await api('Owner', 'PUT', '/ai/config', { purpose: 'text', provider: 'perplexity', apiKey: 'short' }), 422);
});

test('institution profile: accreditation, affiliations, social links and map are validated and public', async () => {
  expect(await api('Owner', 'PATCH', `/institutions/${S.inst._id}`, { socialLinks: { facebook: 'https://evil.example.com/x' } }), 422, 'wrong host');
  expect(await api('Owner', 'PATCH', `/institutions/${S.inst._id}`, { location: { lat: 120, lng: 73 } }), 422, 'bad latitude');
  expect(await api('Owner', 'PATCH', `/institutions/${S.inst._id}`, { accreditations: [{ reference: 'no body' }] }), 422);
  const r = await api('Owner', 'PATCH', `/institutions/${S.inst._id}`, {
    accreditations: [{ body: 'HEC Pakistan', reference: 'HEC-123', validUntil: '2030-01-01', documentUrl: 'https://hec.gov.pk/cert.pdf' }],
    affiliations: [{ name: 'BISE Faisalabad', kind: 'board', since: 2005 }],
    socialLinks: { facebook: 'https://www.facebook.com/gcuf', youtube: 'https://youtu.be/abc' },
    location: { lat: 31.4187, lng: 73.0791 }
  });
  expect(r, 200);
  const pub = await api(null, 'GET', `/public/institutes/${S.inst._id}`);
  expect(pub, 200);
  assert.deepEqual(pub.body.data.location, { lat: 31.4187, lng: 73.0791 });
  assert.equal(pub.body.data.accreditations[0].current, true);
  assert.equal(pub.body.data.affiliations[0].kind, 'board');
  assert.deepEqual(Object.keys(pub.body.data.socialLinks).sort(), ['facebook', 'youtube']);
});
