const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Homepage sections beyond listings: platform numbers, courses, featured teachers and trainers,
// academies, employers, blog and programme figures all come from the database, only for active,
// approved accounts; the search options list only places that have something to find.
process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
async function get(path) { const res = await fetch(base + path); return { status: res.status, body: await res.json().catch(() => null) }; }
async function account(name, role, { approved = true, city = 'Lahore' } = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@home.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: approved ? 'approved' : 'pending_approval' });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Teacher', 'teacher');
  await account('Trainer', 'teacher', { city: 'Karachi' });
  await account('HiddenTeacher', 'teacher');
  await account('PendingTeacher', 'teacher', { approved: false });
  await account('Employer', 'employer');
  await account('Agent', 'education_agent');
  await account('Owner', 'institution_owner');
  await account('Donor', 'donor');
  await account('Admin', 'super_admin');
  for (const n of ['S1', 'S2', 'S3']) await account(n, 'student', { city: n === 'S3' ? 'Multan' : 'Lahore' });
  await model('Country').create({ code: 'PK', name: 'Pakistan' });
  await model('TeacherProfile').create({ user: u.Teacher._id, subjects: ['Mathematics'], experienceYears: 12, publicPortfolio: true, categories: ['school_teacher'] });
  await model('TeacherProfile').create({ user: u.Trainer._id, subjects: ['IELTS'], experienceYears: 8, publicPortfolio: true, categories: ['corporate_trainer'] });
  await model('TeacherProfile').create({ user: u.HiddenTeacher._id, subjects: ['Physics'], publicPortfolio: false });
  await model('TeacherProfile').create({ user: u.PendingTeacher._id, subjects: ['Chemistry'], publicPortfolio: true });
  S.inst = await model('Institution').create({ name: 'GCUF', slug: 'gcuf', type: 'university', country: 'PK', city: 'Faisalabad', owner: u.Owner._id, verificationStatus: 'approved' });
  await model('Institution').create({ name: 'KIPS Academy', slug: 'kips', type: 'academy', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved' });
  S.course = await model('Course').create({ title: 'Algebra Basics', subject: 'Mathematics', level: 'Matric', teacher: u.Teacher._id, published: true, isFree: true });
  await model('Course').create({ title: 'Draft Course', teacher: u.Teacher._id, published: false });
  await model('Course').create({ title: 'Pending Teacher Course', teacher: u.PendingTeacher._id, published: true });
  await model('Enrollment').create({ student: u.S1._id, course: S.course._id });
  await model('Enrollment').create({ student: u.S2._id, course: S.course._id });
  await model('Job').create({ postedBy: u.Employer._id, title: 'Data Analyst', company: 'Insight Co', country: 'PK', city: 'Lahore', type: 'full_time' });
  await model('Job').create({ postedBy: u.Employer._id, title: 'Intern', company: 'Insight Co', country: 'PK', city: 'Karachi', type: 'internship' });
  const sch = await model('Scholarship').create({ donor: u.Donor._id, title: 'STEM Grant', amount: 1000 });
  const app1 = await model('ScholarshipApplication').create({ scholarship: sch._id, applicant: u.S3._id, status: 'approved' });
  await model('Sponsorship').create({ donor: u.Donor._id, scholarship: sch._id, application: app1._id, student: u.S3._id, amount: 1000, status: 'active' });
  await model('BlogPost').create({ slug: 'choose-uni', title: 'How to choose a university', status: 'published', publishedAt: new Date(), author: u.Admin._id, content: 'word '.repeat(450), category: 'Admissions' });
  await model('BlogPost').create({ slug: 'draft-post', title: 'Draft post', status: 'draft', author: u.Admin._id });
  await model('Setting').create({ key: 'commission_rate_percent', value: 12 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('homepage sections are counted from real, approved records', async () => {
  const r = await get('/public/home/sections');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.stats.students, 3);
  assert.equal(d.stats.teachers, 3, 'approved teachers only');
  assert.equal(d.stats.courses, 1, 'published courses of approved teachers only');
  assert.equal(d.stats.employers, 1);
  assert.equal(d.stats.educationAgents, 1);
  assert.equal(d.stats.scholarshipsAwarded, 1);
  assert.equal(d.stats.approvedInstitutes, 2);
  assert.ok(d.stats.cities >= 4, 'Lahore, Karachi, Multan, Faisalabad');
  assert.deepEqual(d.courses.map((c) => [c.title, c.enrolled, c.teacher.name]), [['Algebra Basics', 2, 'Teacher']]);
  assert.deepEqual(d.teachers.map((t) => [t.name, t.experienceYears, t.studentsTaught]), [['Teacher', 12, 2]]);
  assert.deepEqual(d.trainers.map((t) => t.name), ['Trainer']);
  assert.deepEqual(d.academies.map((a) => a.name), ['KIPS Academy']);
  assert.deepEqual(d.employers.map((e) => [e.name, e.openJobs]), [['Insight Co', 2]]);
  assert.deepEqual(d.blog.map((b) => [b.slug, b.readMinutes]), [['choose-uni', 2]]);
  assert.deepEqual(d.programmes, { agent: { commissionRate: 12, activeAgents: 1 }, donor: { studentsSponsored: 1, scholarshipsFunded: 1, scholarshipsPublished: 1, citiesReached: 1 } });
  assert.ok(!JSON.stringify(r.body).includes('home.test'), 'no emails');
});

test('courses list, search and detail; hidden courses are not reachable', async () => {
  assert.equal((await get('/public/courses?q=algebra')).body.data.total, 1);
  assert.equal((await get('/public/courses?q=chemistry')).body.data.total, 0);
  assert.equal((await get('/public/courses?level=matric')).body.data.total, 1);
  const d = await get(`/public/courses/${S.course._id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.teacherPortfolio, true);
  const draft = await model('Course').findOne({ title: 'Draft Course' });
  assert.equal((await get(`/public/courses/${draft._id}`)).status, 404);
});

test('search options list only countries and cities that have listings', async () => {
  const o = (await get('/public/search-options')).body.data;
  assert.deepEqual(o.countries, [{ code: 'PK', name: 'Pakistan' }]);
  assert.deepEqual(o.courseLevels, ['Matric']);
  assert.deepEqual((await get('/public/cities?country=pk')).body.data, ['Faisalabad', 'Karachi', 'Lahore']);
  assert.deepEqual((await get('/public/cities')).body.data, []);
});
