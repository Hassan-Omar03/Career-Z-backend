const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'allot-test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), Institution = m('Institution'), ClassSection = m('ClassSection'), TeacherProfile = m('TeacherProfile'), StudentProfile = m('StudentProfile'), Course = m('Course'), Enrollment = m('Enrollment'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile');

let mongo, server, base, owner, teacher, outsider, student, inst, otherInst, section, O, T, X;
const call = async (method, path, body, auth) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  const passwordHash = await User.hashPassword('Good@Pass123');
  const make = async (fullName, email, role) => {
    const u = await User.create({ fullName, email, passwordHash, emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
    await RoleRequest.create({ user: u._id, requestedRole: role, status: 'approved', approvedAt: new Date(Date.now() - 864e5 * 30) });
    await UserProfile.updateOne({ user: u._id, role }, { $set: { completed: true, percent: 100 } }, { upsert: true });
    return u;
  };
  owner = await make('Institute Owner', 'owner@allot.test', 'institution_owner');
  teacher = await make('Institute Teacher', 'teacher@allot.test', 'teacher');
  outsider = await make('Outside Teacher', 'outside@allot.test', 'teacher');
  student = await make('Class Student', 'student@allot.test', 'student');
  const other = await make('Other Owner', 'other@allot.test', 'institution_owner');
  inst = await Institution.create({ owner: owner._id, name: 'Allot Institute', slug: 'allot', type: 'university', country: 'PK', city: 'Lahore', verificationStatus: 'approved', status: 'active' });
  otherInst = await Institution.create({ owner: other._id, name: 'Other Institute', slug: 'other-allot', type: 'university', country: 'PK', city: 'Lahore', verificationStatus: 'approved', status: 'active' });
  section = await ClassSection.create({ institution: inst._id, name: 'Class A' });
  await TeacherProfile.create({ user: teacher._id, institutions: [inst._id] });
  await StudentProfile.create({ user: student._id, primaryInstitution: inst._id, classSection: section._id, status: 'active' });
  const sign = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  O = sign(owner); T = sign(teacher); X = sign(outsider);
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); });

test('a teacher cannot create a course under any institute, even their own, and is not linked to it', async () => {
  for (const [auth, who] of [[T, 'own'], [X, 'other']]) {
    const r = await call('POST', '/courses', { title: 'Sneaky', institution: inst._id }, auth);
    assert.equal(r.status, 403, who);
  }
  assert.equal((await call('POST', '/courses', { title: 'Sneaky', classSection: section._id }, T)).status, 403);
  assert.equal(await Course.countDocuments({ title: 'Sneaky' }), 0);
  assert.equal(await TeacherProfile.exists({ user: outsider._id, institutions: inst._id }), null);
});

test('a teacher can still create their own independent course', async () => {
  const r = await call('POST', '/courses', { title: 'My Own Course', subject: 'Maths' }, T);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.institution, null);
});

test('the institute creates a course, it reaches the teacher and the class students', async () => {
  const r = await call('POST', '/institutions/' + inst._id + '/courses', { title: 'Physics', subject: 'Physics', classSection: section._id, teacher: teacher._id, creditHours: 4, academicTerm: 'Semester 1' }, O);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.published, true);
  assert.equal(r.body.data.isFree, false);
  assert.equal(r.body.data.creditHours, 4);
  const mine = await call('GET', '/courses/mine/list', undefined, T);
  assert.ok(mine.body.data.some((c) => c.title === 'Physics'));
  assert.ok(await Enrollment.exists({ student: student._id, course: r.body.data._id }));
  assert.equal((await call('POST', '/institutions/' + inst._id + '/courses', { title: 'Physics', subject: 'Physics', classSection: section._id, teacher: teacher._id }, O)).status, 409);
});

test('the institute sees the teacher degree, and allots and removes students', async () => {
  await TeacherProfile.updateOne({ user: teacher._id }, { $set: { subjects: ['Physics'], experienceYears: 6, qualifications: [{ title: 'MSc Physics', institutionName: 'PU', year: 2015 }] } });
  const list = await call('GET', '/institutions/' + inst._id + '/teachers', undefined, O);
  const row = list.body.data.find((t) => String(t.user._id) === String(teacher._id));
  assert.equal(row.qualifications[0].title, 'MSc Physics');
  assert.deepEqual(row.subjects, ['Physics']);

  const StudentMembership = m('StudentInstitutionMembership');
  const joined = await User.create({ fullName: 'Second Student', email: 'second@allot.test', passwordHash: 'x', roles: ['student'], status: 'active' });
  await StudentProfile.create({ user: joined._id, primaryInstitution: inst._id, status: 'active' });
  await StudentMembership.create([{ student: joined._id, institution: inst._id, status: 'active' }, { student: student._id, institution: inst._id, status: 'active' }]);
  const stranger = await User.create({ fullName: 'Stranger', email: 'stranger@allot.test', passwordHash: 'x', roles: ['student'], status: 'active' });
  const made = await call('POST', '/institutions/' + inst._id + '/courses', { title: 'Biology', subject: 'Biology', classSection: section._id, teacher: teacher._id }, O);
  const path = '/institutions/' + inst._id + '/courses/' + made.body.data._id + '/students';
  assert.deepEqual((await call('GET', path, undefined, O)).body.data.map(String), [String(student._id)], 'the class student is already in');

  const saved = await call('PUT', path, { students: [joined._id] }, O);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.added, 1);
  assert.equal(saved.body.data.removed, 1);
  assert.deepEqual((await call('GET', path, undefined, O)).body.data.map(String), [String(joined._id)]);
  assert.equal((await Enrollment.findOne({ student: student._id, course: made.body.data._id })).status, 'dropped');
  const back = await call('PUT', path, { students: [joined._id, student._id] }, O);
  assert.equal(back.body.data.added, 1);
  assert.equal((await Enrollment.findOne({ student: student._id, course: made.body.data._id })).status, 'active');

  assert.equal((await call('PUT', path, { students: [stranger._id] }, O)).status, 422);
  assert.equal((await call('PUT', path, { students: 'all' }, O)).status, 422);
  assert.equal((await call('PUT', path, { students: [joined._id] }, T)).status, 403);
  assert.equal((await call('GET', path, undefined, X)).status, 403);
});

test('only that institute can create, with its own class and its own teacher', async () => {
  const good = { title: 'Chem', subject: 'Chem', classSection: section._id, teacher: teacher._id };
  const path = '/institutions/' + inst._id + '/courses';
  assert.equal((await call('POST', path, good, T)).status, 403);
  assert.equal((await call('POST', path, good, X)).status, 403);
  assert.equal((await call('POST', path, { ...good, teacher: outsider._id }, O)).status, 422);
  assert.equal((await call('POST', path, { ...good, classSection: new mongoose.Types.ObjectId() }, O)).status, 422);
  assert.equal((await call('POST', path, { ...good, title: { a: 1 } }, O)).status, 422);
  assert.equal((await call('POST', '/institutions/' + otherInst._id + '/courses', good, O)).status, 403);
  assert.equal(await Course.countDocuments({ title: 'Chem' }), 0);
});
