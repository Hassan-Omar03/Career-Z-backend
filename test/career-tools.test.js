const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// CV versions + autofill, career roadmaps (AI stubbed), internship certificates and the opt-in
// working-hours policy, over real HTTP.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'career-tools-test-secret';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const aiService = require('../src/services/ai.service');
let aiReply = '';
mock.method(aiService, 'generate', async () => { if (aiReply instanceof Error) throw aiReply; return aiReply; });

const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '10m' });
async function call(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function account(name, role, extra = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@tools.test`, passwordHash: 'x', roles: [role], ...extra });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  for (const m of ['ResumeVariant', 'InternshipCertificate', 'CareerRoadmap', 'Certificate']) await model(m).init();
  await account('Student', 'student', { city: 'Lahore', country: 'Pakistan' });
  await account('Other', 'student');
  await account('Employer', 'employer');
  await account('OtherEmployer', 'employer');
  await account('Owner', 'institution_owner');
  await account('Teacher', 'teacher');
  u.school = await model('Institution').create({ name: 'Tools School', slug: 'tools-school', type: 'school', country: 'PK', owner: u.Owner._id, verificationStatus: 'approved' });
  await model('StudentProfile').create({ user: u.Student._id, primaryInstitution: u.school._id, program: 'BS Computer Science', careerGoal: 'Data Analyst', skills: ['Python', 'SQL'], languages: ['Urdu', 'English'] });
  await model('StudentInstitutionMembership').create({ student: u.Student._id, institution: u.school._id, status: 'active', isPrimary: true, joinedAt: new Date('2024-09-01'), program: 'BS Computer Science' });
  await model('Certificate').create({ student: u.Student._id, institution: u.school._id, title: 'Database Systems', issuedBy: u.Owner._id });
  await model('Achievement').create({ student: u.Student._id, type: 'competition', title: 'Hackathon winner', evidenceUrl: 'https://example.test/h', verificationStatus: 'verified' });
  await model('Achievement').create({ student: u.Student._id, type: 'award', title: 'Unverified claim', verificationStatus: 'pending' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('internship certificate: only the hiring employer, only for a hired intern, once; verifiable; revocable', async () => {
  const job = await model('Job').create({ title: 'Data Intern', company: 'Acme Analytics', type: 'internship', country: 'PK', postedBy: u.Employer._id, description: 'x' });
  const fullTime = await model('Job').create({ title: 'Engineer', company: 'Acme Analytics', type: 'full_time', country: 'PK', postedBy: u.Employer._id, description: 'x' });
  const app1 = await model('JobApplication').create({ job: job._id, applicant: u.Student._id, status: 'shortlisted' });
  const app2 = await model('JobApplication').create({ job: fullTime._id, applicant: u.Student._id, status: 'hired' });
  const body = { applicationId: String(app1._id), startDate: '2026-06-01', endDate: '2026-08-31', hours: 240, skills: 'Excel, Power BI', remarks: 'Built sales dashboards' };
  assert.equal((await call('Employer', 'POST', '/career-tools/internship-certificates/employer', body)).status, 409, 'issued before hire');
  await model('JobApplication').updateOne({ _id: app1._id }, { status: 'hired' });
  assert.equal((await call('OtherEmployer', 'POST', '/career-tools/internship-certificates/employer', body)).status, 403);
  assert.equal((await call('Employer', 'POST', '/career-tools/internship-certificates/employer', { ...body, applicationId: String(app2._id) })).status, 422, 'non-internship job');
  assert.equal((await call('Employer', 'POST', '/career-tools/internship-certificates/employer', { ...body, endDate: '2099-01-01' })).status, 422, 'future end date');
  const issued = await call('Employer', 'POST', '/career-tools/internship-certificates/employer', body);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.ok(issued.body.data.qrDataUrl.startsWith('data:image/png'));
  assert.equal((await call('Employer', 'POST', '/career-tools/internship-certificates/employer', body)).status, 409, 'duplicate certificate');
  const verify = await fetch(`${base}/certificates/verify/${issued.body.data.verifyCode}`).then((r) => r.json());
  assert.equal(verify.data.type, 'internship');
  assert.equal(verify.data.organization, 'Acme Analytics');
  assert.equal(verify.data.status, 'active');
  const mine = await call('Student', 'GET', '/career-tools/internship-certificates/mine');
  assert.equal(mine.body.data.length, 1);
  assert.equal((await call('Other', 'GET', '/career-tools/internship-certificates/mine')).body.data.length, 0);
  assert.equal((await call('Student', 'PATCH', `/career-tools/internship-certificates/${issued.body.data._id}/revoke`, { reason: 'x' })).status, 403);
  assert.equal((await call('Employer', 'PATCH', `/career-tools/internship-certificates/${issued.body.data._id}/revoke`, { reason: '' })).status, 422);
  assert.equal((await call('Employer', 'PATCH', `/career-tools/internship-certificates/${issued.body.data._id}/revoke`, { reason: 'Issued in error' })).status, 200);
  assert.equal((await fetch(`${base}/certificates/verify/${issued.body.data.verifyCode}`).then((r) => r.json())).data.status, 'revoked');
  // A new certificate can be issued after revoking the wrong one; it feeds CV autofill.
  assert.equal((await call('Employer', 'POST', '/career-tools/internship-certificates/employer', body)).status, 201);
});

test('internship certificate from the institution placement office needs a current or former student', async () => {
  const body = { institutionId: String(u.school._id), organization: 'City Hospital', role: 'Admin Intern', startDate: '2026-01-01', endDate: '2026-02-01' };
  assert.equal((await call('Owner', 'POST', '/career-tools/internship-certificates/institution', { ...body, studentId: String(u.Other._id) })).status, 403, 'non-member student');
  assert.equal((await call('Teacher', 'POST', '/career-tools/internship-certificates/institution', { ...body, studentId: String(u.Student._id) })).status, 403, 'outside staff');
  assert.equal((await call('Owner', 'POST', '/career-tools/internship-certificates/institution', { ...body, studentId: String(u.Student._id) })).status, 201);
});

test('CV autofill uses only real records and never overwrites what the student wrote', async () => {
  const draft = (await call('Student', 'GET', '/resumes/autofill')).body.data;
  assert.equal(draft.headline, 'Data Analyst');
  assert.equal(draft.location, 'Lahore, Pakistan');
  assert.deepEqual(draft.education.map((e) => e.institution), ['Tools School']);
  assert.ok(draft.certifications.some((c) => c.startsWith('Database Systems')));
  assert.ok(draft.experience.some((e) => e.company === 'Acme Analytics'), 'internship missing from experience');
  assert.ok(draft.skills.includes('Python') && draft.skills.includes('Power BI'));
  assert.deepEqual(draft.portfolio.map((p) => p.title), ['Hackathon winner'], 'unverified achievement leaked');
  await call('Student', 'PATCH', '/resumes/me', { headline: 'My own headline', skills: ['Python'] });
  const filled = (await call('Student', 'POST', '/resumes/me/autofill')).body.data;
  assert.equal(filled.resume.headline, 'My own headline', 'autofill overwrote the headline');
  assert.equal(filled.resume.skills.filter((s) => s === 'Python').length, 1, 'duplicated skill');
  assert.ok(filled.resume.education.length === 1 && filled.resume.certifications.length >= 1);
  const again = (await call('Student', 'POST', '/resumes/me/autofill')).body.data;
  assert.deepEqual(again.added, {}, 'second autofill added duplicates');
});

test('CV versions: up to 5, unique names, one default, owner-only', async () => {
  const first = await call('Student', 'POST', '/resumes/variants', { name: 'Data roles', targetRole: 'Data Analyst', from: 'main' });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.isDefault, true);
  assert.equal(first.body.data.headline, 'My own headline');
  assert.equal((await call('Student', 'POST', '/resumes/variants', { name: 'Data roles' })).status, 409, 'duplicate name');
  assert.equal((await call('Student', 'POST', '/resumes/variants', { name: '' })).status, 422);
  const blank = await call('Student', 'POST', '/resumes/variants', { name: 'Teaching assistant', from: 'blank' });
  assert.equal(blank.body.data.headline, '');
  const filled = await call('Student', 'POST', `/resumes/variants/${blank.body.data._id}/autofill`);
  assert.equal(filled.body.data.variant.headline, 'Data Analyst');
  const copy = await call('Student', 'POST', '/resumes/variants', { name: 'Copy', from: first.body.data._id });
  assert.equal(copy.body.data.headline, 'My own headline');
  for (const name of ['Four', 'Five']) assert.equal((await call('Student', 'POST', '/resumes/variants', { name, from: 'blank' })).status, 201);
  assert.equal((await call('Student', 'POST', '/resumes/variants', { name: 'Six', from: 'blank' })).status, 409, 'more than 5 versions');
  assert.equal((await call('Other', 'PATCH', `/resumes/variants/${first.body.data._id}`, { name: 'Stolen' })).status, 404);
  assert.equal((await call('Other', 'POST', '/resumes/variants', { name: 'x', from: first.body.data._id })).status, 404, 'copied another student CV');
  assert.equal((await call('Student', 'POST', `/resumes/variants/${blank.body.data._id}/default`)).status, 200);
  let rows = (await call('Student', 'GET', '/resumes/variants')).body.data;
  assert.equal(rows.filter((r) => r.isDefault).length, 1);
  assert.equal(rows.find((r) => r.isDefault).name, 'Teaching assistant');
  assert.equal((await call('Student', 'DELETE', `/resumes/variants/${blank.body.data._id}`)).status, 200);
  rows = (await call('Student', 'GET', '/resumes/variants')).body.data;
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.isDefault).length, 1, 'no default after deleting the default');
});

test('career roadmap: manual plan, AI plan only with consent, bad AI replies rejected, owner-only progress', async () => {
  const manual = await call('Student', 'POST', '/career-tools/roadmaps', { targetCareer: 'Data Analyst', horizonMonths: 6, steps: [{ title: 'Learn SQL joins', category: 'skill' }] });
  assert.equal(manual.status, 201);
  assert.equal((await call('Student', 'POST', '/career-tools/roadmaps', { targetCareer: '', steps: [] })).status, 422);
  aiReply = '{"steps":[{"title":"Statistics basics","detail":"Khan Academy","category":"course","month":1},{"title":"Portfolio project","category":"project","month":5}]}';
  assert.equal((await call('Student', 'POST', '/career-tools/roadmaps/generate', { targetCareer: 'Data Analyst', horizonMonths: 6 })).status, 422, 'generated without consent');
  const ai = await call('Student', 'POST', '/career-tools/roadmaps/generate', { targetCareer: 'Data Analyst', horizonMonths: 6, dataConsent: true });
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  assert.equal(ai.body.data.source, 'ai');
  assert.equal(ai.body.data.steps.length, 2);
  assert.ok(new Date(ai.body.data.steps[1].targetDate) > new Date(ai.body.data.steps[0].targetDate));
  aiReply = 'Sure! Here are some ideas without JSON.';
  assert.equal((await call('Student', 'POST', '/career-tools/roadmaps/generate', { targetCareer: 'Designer', dataConsent: true })).status, 502);
  aiReply = Object.assign(new Error('Connect a text AI provider first.'), { statusCode: 400 });
  const noKey = await call('Student', 'POST', '/career-tools/roadmaps/generate', { targetCareer: 'Designer', dataConsent: true });
  assert.equal(noKey.status, 400);
  assert.match(noKey.body.message, /Connect a text AI provider/);
  const stepId = manual.body.data.steps[0]._id;
  assert.equal((await call('Other', 'PATCH', `/career-tools/roadmaps/${manual.body.data._id}/steps/${stepId}`, { status: 'done' })).status, 404);
  const done = await call('Student', 'PATCH', `/career-tools/roadmaps/${manual.body.data._id}/steps/${stepId}`, { status: 'done' });
  assert.equal(done.body.data.steps[0].status, 'done');
  assert.ok(done.body.data.steps[0].completedAt);
  assert.equal((await call('Student', 'GET', '/career-tools/roadmaps')).body.data.length, 2);
});

test('working hours are enforced only when the institution opts in, in its own timezone', async () => {
  const section = await model('ClassSection').create({ institution: u.school._id, name: 'WH' });
  const course = await model('Course').create({ title: 'WH Math', teacher: u.Teacher._id, institution: u.school._id, classSection: section._id, isFree: true, published: true });
  // Next Monday 18:00 and 10:00 in Asia/Karachi (UTC+5).
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const at = (h) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 5, 0));
  const live = (h) => call('Teacher', 'POST', '/live-classes', { institution: String(u.school._id), course: String(course._id), scheduledStart: at(h).toISOString(), scheduledEnd: at(h + 1).toISOString(), title: 'Revision' });
  assert.equal((await live(18)).status, 201, 'blocked although the policy is off');
  await model('InstitutionSettings').create({ institution: u.school._id, timezone: 'Asia/Karachi', workingDays: [1, 2, 3, 4, 5], schoolHours: { start: '08:00', end: '14:00' } });
  assert.equal((await call('Teacher', 'PUT', `/institutions/${u.school._id}/settings`, { workingHoursPolicy: { liveClasses: true } })).status, 403, 'teacher changed school policy');
  assert.equal((await call('Owner', 'PUT', `/institutions/${u.school._id}/settings`, { workingHoursPolicy: { liveClasses: 'yes' } })).status, 422);
  assert.equal((await call('Owner', 'PUT', `/institutions/${u.school._id}/settings`, { workingHoursPolicy: { liveClasses: true } })).status, 200);
  const evening = await live(18);
  assert.equal(evening.status, 422);
  assert.match(evening.body.message, /working hours/);
  assert.equal((await live(10)).status, 201);
  assert.equal((await live(13)).status, 201, 'class ending exactly at closing time');
  assert.equal((await live(14)).status, 422, 'class after school hours');
});
