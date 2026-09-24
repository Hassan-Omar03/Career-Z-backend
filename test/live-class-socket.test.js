const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { io: ioClient } = require('socket.io-client');

process.env.NODE_ENV = 'test';
const env = require('../src/config/env');
const { initSocket } = require('../src/realtime/socket');

const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Enrollment = require('../src/models/Enrollment');
const Fee = require('../src/models/Fee');

let mongo, httpServer, baseUrl, teacher, otherTeacher, student, unrelatedStudent, feeBlockedStudent, course;
const models = [User, Course, Institution, ClassSection, Enrollment, Fee];
const DECK = [{ title: 'Slide 1', bullets: ['a'] }, { title: 'Slide 2', bullets: ['b'] }, { title: 'Slide 3', bullets: ['c'] }];

function tokenFor(user) {
  return jwt.sign({ sub: user._id.toString() }, env.jwt.accessSecret, { algorithm: 'HS256', expiresIn: '1h' });
}

function connect(user, overrideToken) {
  const socket = ioClient(baseUrl, { auth: { accessToken: overrideToken !== undefined ? overrideToken : tokenFor(user) }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.timeout(4000).emit(event, payload, (err, ack) => resolve(err ? { ok: false, message: 'timeout' } : ack)));
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
  httpServer = http.createServer();
  initSocket(httpServer);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  teacher = await User.create({ fullName: 'Live Teacher', email: 'live-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  otherTeacher = await User.create({ fullName: 'Other Teacher', email: 'other-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  student = await User.create({ fullName: 'Live Student', email: 'live-student@test.local', passwordHash: 'x', roles: ['student'] });
  unrelatedStudent = await User.create({ fullName: 'Unrelated Student', email: 'unrelated-student@test.local', passwordHash: 'x', roles: ['student'] });
  feeBlockedStudent = await User.create({ fullName: 'Fee Blocked Student', email: 'fee-blocked-student@test.local', passwordHash: 'x', roles: ['student'] });
  const institution = await Institution.create({ name: 'Live Institution', slug: 'live-institution', type: 'school', country: 'PK', owner: teacher._id, verificationStatus: 'approved' });
  course = await Course.create({ title: 'Live Course', teacher: teacher._id, institution: institution._id, published: true, isFree: false });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
  await Enrollment.create({ student: feeBlockedStudent._id, course: course._id, status: 'active' });
  await Fee.create({ student: feeBlockedStudent._id, institution: institution._id, title: 'Tuition', amount: 100, currency: 'USD', status: 'pending', dueDate: new Date(Date.now() - 86400000), recordedBy: teacher._id });
});

test('a forged/invalid token is rejected at connection', async () => {
  await assert.rejects(connect(null, jwt.sign({ sub: '000000000000000000000000' }, 'wrong-secret')));
});

test('teacher starts a class; unrelated student cannot join, enrolled student can', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });
  assert.equal(started.ok, true);
  const sessionId = started.session.id;

  const unrelatedSocket = await connect(unrelatedStudent);
  const unrelatedJoin = await emitAck(unrelatedSocket, 'class:join', { sessionId });
  assert.equal(unrelatedJoin.ok, false, 'an unrelated student must never be able to join by guessing/knowing the session id');

  const studentSocket = await connect(student);
  const studentJoin = await emitAck(studentSocket, 'class:join', { sessionId });
  assert.equal(studentJoin.ok, true);
  assert.equal(studentJoin.session.slides.length, 3);

  teacherSocket.close(); unrelatedSocket.close(); studentSocket.close();
});

test('a student with a blocking due fee cannot join', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });

  const blockedSocket = await connect(feeBlockedStudent);
  const join = await emitAck(blockedSocket, 'class:join', { sessionId: started.session.id });
  assert.equal(join.ok, false);
  assert.match(join.message, /fee/i);

  teacherSocket.close(); blockedSocket.close();
});

test('only the owning teacher can control or end the class', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });
  const sessionId = started.session.id;

  const impostorSocket = await connect(otherTeacher);
  const impostorControl = await emitAck(impostorSocket, 'class:control', { sessionId, currentSlide: 2 });
  assert.equal(impostorControl.ok, false);
  const impostorEnd = await emitAck(impostorSocket, 'class:end', { sessionId });
  assert.equal(impostorEnd.ok, false);

  const studentSocket = await connect(student);
  await emitAck(studentSocket, 'class:join', { sessionId });
  const studentControl = await emitAck(studentSocket, 'class:control', { sessionId, currentSlide: 1 });
  assert.equal(studentControl.ok, false, 'a student must never be able to drive the slide');
  const studentEnd = await emitAck(studentSocket, 'class:end', { sessionId });
  assert.equal(studentEnd.ok, false, 'a student must never be able to end the class');

  teacherSocket.close(); impostorSocket.close(); studentSocket.close();
});

test('teacher control broadcasts the exact slide index to every joined student', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });
  const sessionId = started.session.id;

  const studentSocket = await connect(student);
  await emitAck(studentSocket, 'class:join', { sessionId });

  const slideEvent = new Promise((resolve) => studentSocket.once('class:slide', resolve));
  const ack = await emitAck(teacherSocket, 'class:control', { sessionId, currentSlide: 2 });
  assert.equal(ack.ok, true);
  const received = await slideEvent;
  assert.equal(received.currentSlide, 2);

  teacherSocket.close(); studentSocket.close();
});

test('a student question reaches the room, and a raised hand reaches the teacher with the real name', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });
  const sessionId = started.session.id;

  const studentSocket = await connect(student);
  await emitAck(studentSocket, 'class:join', { sessionId });

  const messageOnTeacher = new Promise((resolve) => teacherSocket.once('class:message', resolve));
  const msgAck = await emitAck(studentSocket, 'class:message', { sessionId, text: 'Can you repeat that?' });
  assert.equal(msgAck.ok, true);
  const msg = await messageOnTeacher;
  assert.equal(msg.text, 'Can you repeat that?');
  assert.equal(msg.name, 'Live Student');

  const handOnTeacher = new Promise((resolve) => teacherSocket.once('class:hand', resolve));
  const handAck = await emitAck(studentSocket, 'class:raise-hand', { sessionId, raised: true });
  assert.equal(handAck.ok, true);
  const hand = await handOnTeacher;
  assert.equal(hand.name, 'Live Student');
  assert.equal(hand.raised, true);

  teacherSocket.close(); studentSocket.close();
});

test('an oversized deck is rejected', async () => {
  const teacherSocket = await connect(teacher);
  const hugeDeck = Array.from({ length: 60 }, (_, i) => ({ title: `Slide ${i}`, bullets: ['x'] }));
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: hugeDeck });
  assert.equal(started.ok, false);
  teacherSocket.close();
});

test('ending the class invalidates further join and message attempts', async () => {
  const teacherSocket = await connect(teacher);
  const started = await emitAck(teacherSocket, 'class:start', { courseId: course._id.toString(), slides: DECK });
  const sessionId = started.session.id;

  const studentSocket = await connect(student);
  await emitAck(studentSocket, 'class:join', { sessionId });

  const endedEvent = new Promise((resolve) => studentSocket.once('class:ended', resolve));
  const endAck = await emitAck(teacherSocket, 'class:end', { sessionId });
  assert.equal(endAck.ok, true);
  await endedEvent;

  const lateMessage = await emitAck(studentSocket, 'class:message', { sessionId, text: 'still here?' });
  assert.equal(lateMessage.ok, false);

  const lateStudentSocket = await connect(unrelatedStudent);
  const lateJoin = await emitAck(lateStudentSocket, 'class:join', { sessionId });
  assert.equal(lateJoin.ok, false);

  teacherSocket.close(); studentSocket.close(); lateStudentSocket.close();
});
