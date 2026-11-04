const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'attendance-test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
mock.method(notifications, 'notifyMany', async () => {});
const app = require('../src/app');
const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Attendance = require('../src/models/Attendance');
const RoleRequest = require('../src/models/RoleRequest');
const UserProfile = require('../src/models/UserProfile');

let mongo, server, base, teacher, student, other, course, T, S, O;
const call = async (method, path, body, auth) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const recordOn = async (date, id) => {
  const sheets = await Attendance.find({ course: course._id, date: { $gte: new Date(date + 'T00:00:00.000Z'), $lte: new Date(date + 'T23:59:59.999Z') } }).lean();
  return sheets.flatMap((s) => s.records).find((r) => String(r.student) === String(id));
};
const absent = (date, id) => call('POST', '/teachers/me/attendance', { course: course._id, date, records: [{ student: id, status: 'absent', reason: 'Not in class' }] }, T);

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
  teacher = await make('Class Teacher', 't@att.test', 'teacher');
  student = await make('Joining Student', 's@att.test', 'student');
  other = await make('Other Student', 'o@att.test', 'student');
  course = await Course.create({ title: 'Maths', description: 'Maths course', teacher: teacher._id, published: true, price: 0, currency: 'PKR', isFree: true });
  await Enrollment.create([{ student: student._id, course: course._id }, { student: other._id, course: course._id }]);
  const sign = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  T = sign(teacher); S = sign(student); O = sign(other);
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); });

test('a QR check-in turns an absent mark into present', async () => {
  const date = day(10);
  assert.ok((await absent(date, student._id)).status < 300);
  const session = await call('POST', '/teachers/me/attendance/qr-session', { course: course._id, date, minutesValid: 10 }, T);
  assert.equal((await call('POST', '/students/me/attendance/qr-checkin', { token: session.body.data.sessionCode }, S)).status, 200);
  const r = await recordOn(date, student._id);
  assert.equal(r.status, 'present');
  assert.equal(r.method, 'qr');
});

test('a location check-in turns an absent mark into present, and far away is refused', async () => {
  const date = day(11);
  await absent(date, student._id);
  await call('PATCH', '/teachers/me/courses/' + course._id + '/attendance-location', { enabled: true, lat: 31.5, lng: 74.3, radiusMeters: 100 }, T);
  assert.equal((await call('POST', '/students/me/attendance/gps-checkin', { course: course._id, date, lat: 32, lng: 74.3 }, S)).status, 422);
  assert.equal((await recordOn(date, student._id)).status, 'absent');
  assert.equal((await call('POST', '/students/me/attendance/gps-checkin', { course: course._id, date, lat: 31.5001, lng: 74.3 }, S)).status, 200);
  assert.equal((await recordOn(date, student._id)).status, 'present');
});

test('a teacher face scan turns an absent mark into present', async () => {
  const date = day(12);
  await absent(date, student._id);
  assert.equal((await call('POST', '/teachers/me/attendance/face-scan', { studentId: student._id, course: course._id, date }, T)).status, 200);
  const r = await recordOn(date, student._id);
  assert.equal(r.status, 'present');
  assert.equal(r.method, 'face');
});

test('in a live class the teacher can mark a student by hand, and that decides the record', async () => {
  const live = await call('POST', '/live-classes', { course: course._id, title: 'Manual class', scheduledStart: new Date(Date.now() + 6e4), scheduledEnd: new Date(Date.now() + 36e5) }, T);
  const id = live.body.data._id;
  await call('PATCH', '/live-classes/' + id + '/start', undefined, T);
  await call('POST', '/live-classes/' + id + '/join', undefined, S);
  assert.equal((await call('PATCH', '/live-classes/' + id + '/physical-attendance', { records: [{ student: student._id, status: 'absent' }, { student: other._id, status: 'excused' }] }, T)).status, 200);
  assert.equal((await call('PATCH', '/live-classes/' + id + '/physical-attendance', { records: [{ student: new mongoose.Types.ObjectId(), status: 'present' }] }, T)).status, 422);
  assert.equal((await call('PATCH', '/live-classes/' + id + '/physical-attendance', { records: [{ student: student._id, status: 'present' }] }, S)).status, 403);
  await call('PATCH', '/live-classes/' + id + '/end', undefined, T);
  const sheet = await Attendance.findOne({ liveClassSession: id }).lean();
  assert.equal(sheet.records.find((r) => String(r.student) === String(student._id)).status, 'absent');
  assert.equal(sheet.records.find((r) => String(r.student) === String(other._id)).status, 'excused');
  await Attendance.deleteMany({ liveClassSession: id });
});

test('ending a live class: joined is present, QR during the class is present, nobody else is', async () => {
  const live = await call('POST', '/live-classes', { course: course._id, title: 'Class', scheduledStart: new Date(Date.now() + 6e4), scheduledEnd: new Date(Date.now() + 36e5) }, T);
  assert.equal(live.status, 201);
  const id = live.body.data._id;
  assert.equal((await call('PATCH', '/live-classes/' + id + '/start', undefined, T)).status, 200);
  assert.equal((await call('POST', '/live-classes/' + id + '/join', undefined, S)).status, 200);
  const roster = await call('GET', '/live-classes/' + id + '/roster', undefined, T);
  assert.equal(roster.body.data.students.length, 2);
  assert.equal((await call('PATCH', '/live-classes/' + id + '/end', undefined, T)).status, 200);
  const sheet = await Attendance.findOne({ liveClassSession: id }).lean();
  const of = (u) => sheet.records.find((r) => String(r.student) === String(u._id));
  assert.equal(of(student).status, 'present');
  assert.equal(of(student).method, 'live');
  assert.equal(of(other).status, 'absent');

  const second = await call('POST', '/live-classes', { course: course._id, title: 'Class 2', scheduledStart: new Date(Date.now() + 6e4), scheduledEnd: new Date(Date.now() + 36e5) }, T);
  const id2 = second.body.data._id;
  await call('PATCH', '/live-classes/' + id2 + '/start', undefined, T);
  const qr = await call('POST', '/teachers/me/attendance/qr-session', { course: course._id, date: new Date().toISOString(), minutesValid: 10 }, T);
  assert.equal((await call('POST', '/students/me/attendance/qr-checkin', { token: qr.body.data.sessionCode }, O)).status, 200);
  assert.equal((await call('PATCH', '/live-classes/' + id2 + '/end', undefined, T)).status, 200);
  const sheet2 = await Attendance.findOne({ liveClassSession: id2 }).lean();
  const rec = sheet2.records.find((r) => String(r.student) === String(other._id));
  assert.equal(rec.status, 'present');
  assert.equal(rec.method, 'qr');
  assert.equal(sheet2.records.find((r) => String(r.student) === String(student._id)).status, 'absent');
});
