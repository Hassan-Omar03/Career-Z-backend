const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyMany', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const InstitutionSettings = require('../src/models/InstitutionSettings');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const LiveClassSession = require('../src/models/LiveClassSession');
require('../src/models/ClassSection');
const settingsCtrl = require('../src/controllers/institutionSettings.controller');
const liveTools = require('../src/controllers/liveTools.controller');
const liveClass = require('../src/controllers/liveClass.controller');

const models = [User, Institution, InstitutionSettings, Course, Enrollment, LiveClassSession];
let mongo, owner, staff, teacher, student, institution, session;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  [owner, staff, teacher, student] = await User.create(['owner', 'staff', 'teacher', 'student'].map((n) => ({ fullName: n, email: `${n}@set.test`, passwordHash: 'x' })));
  institution = await Institution.create({ name: 'GCUF', slug: 'gcuf-set', type: 'university', country: 'PK', owner: owner._id, verificationStatus: 'approved', staff: [{ user: staff._id, role: 'staff' }] });
  const course = await Course.create({ title: 'Physics', teacher: teacher._id, institution: institution._id });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
  session = await LiveClassSession.create({ institution: institution._id, course: course._id, classSection: new mongoose.Types.ObjectId(), teacher: teacher._id, title: 'Lecture 1', createdBy: owner._id, scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3600000), roomName: `room-${Date.now()}`, status: 'live' });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {}, headers: {} }, res, reject)).catch(reject);
  });
}
const save = (user, body) => invoke(settingsCtrl.saveSettings, { user, params: { id: institution.id }, body });

test('owner customises branding, pages, subdomain, timezone and working days; the public sees only public parts', async () => {
  await save(owner, {
    branding: { primaryColor: '#0f5132', accentColor: '#d4a017', tagline: 'Knowledge for all' },
    pages: [{ slug: 'about', title: 'About us', body: 'Founded 1897', published: true }, { slug: 'draft', title: 'Draft', published: false }],
    subdomain: 'gcuf', timezone: 'Asia/Karachi', workingDays: [1, 2, 3, 4, 5, 6], schoolHours: { start: '08:30', end: '15:00' }
  });
  const pub = (await invoke(settingsCtrl.bySubdomain, { params: { subdomain: 'GCUF' } })).body.data;
  assert.equal(pub.institution.name, 'GCUF');
  assert.equal(pub.branding.primaryColor, '#0f5132');
  assert.deepEqual(pub.pages, [{ slug: 'about', title: 'About us' }]);
  assert.deepEqual(pub.workingDays, [1, 2, 3, 4, 5, 6]);
  assert.equal((await invoke(settingsCtrl.getPage, { params: { id: institution.id, slug: 'about' } })).body.data.body, 'Founded 1897');
  await assert.rejects(invoke(settingsCtrl.getPage, { params: { id: institution.id, slug: 'draft' } }), { statusCode: 404 });
  const asStudent = (await invoke(settingsCtrl.getSettings, { user: student, params: { id: institution.id } })).body.data;
  assert.equal(asStudent.updatedBy, undefined); // public view only
});

test('settings validation and permissions', async () => {
  await assert.rejects(save(staff, { timezone: 'Asia/Karachi' }), { statusCode: 403 });
  await Institution.updateOne({ _id: institution._id, 'staff.user': staff._id }, { $set: { 'staff.$.permissions': ['settings:manage'] } });
  await save(staff, { timezone: 'Europe/London' });
  await assert.rejects(save(owner, { timezone: 'Mars/Base' }), { statusCode: 422 });
  await assert.rejects(save(owner, { subdomain: 'admin' }), { statusCode: 422 });
  await assert.rejects(save(owner, { workingDays: [9] }), { statusCode: 422 });
  await assert.rejects(save(owner, { branding: { primaryColor: 'red' } }), { statusCode: 422 });
  await assert.rejects(save(owner, { schoolHours: { start: '15:00', end: '08:00' } }), { statusCode: 422 });
  await assert.rejects(save(owner, { pages: [{ slug: 'Bad Slug!', title: 'x' }] }), { statusCode: 422 });
  const other = await Institution.create({ name: 'Other', slug: 'other-set', type: 'school', country: 'PK', owner: teacher._id });
  await InstitutionSettings.create({ institution: other._id, subdomain: 'taken' });
  await assert.rejects(save(owner, { subdomain: 'taken' }), { statusCode: 409 });
});

test('recording disabled by the institution: the teacher cannot switch it on or upload a recording', async () => {
  await save(owner, { classroom: { recordingPolicy: 'disabled' } });
  await assert.rejects(invoke(liveTools.update, { user: teacher, params: { id: session.id }, body: { action: 'recording', enabled: true } }), { statusCode: 403 });
  await assert.rejects(invoke(liveClass.recording, { user: teacher, params: { id: session.id }, body: { url: 'https://cdn.example/rec.webm' } }), { statusCode: 403 });
});

test('consent required: students answer yes/no, the teacher sees the answers', async () => {
  await save(owner, { classroom: { recordingPolicy: 'teacher_choice', requireStudentConsent: true } });
  await assert.rejects(invoke(liveTools.update, { user: student, params: { id: session.id }, body: { action: 'recordingConsent', consent: true } }), { statusCode: 409 }); // not recording yet
  await invoke(liveTools.update, { user: teacher, params: { id: session.id }, body: { action: 'recording', enabled: true } });
  const before = (await invoke(liveTools.state, { user: student, params: { id: session.id } })).body.data;
  assert.equal(before.recordingConsentRequired, true);
  assert.equal(before.myRecordingConsent, null);
  await invoke(liveTools.update, { user: student, params: { id: session.id }, body: { action: 'recordingConsent', consent: false } });
  const after = (await invoke(liveTools.state, { user: student, params: { id: session.id } })).body.data;
  assert.equal(after.myRecordingConsent, false);
  const teacherView = (await invoke(liveTools.state, { user: teacher, params: { id: session.id } })).body.data;
  assert.equal(teacherView.recordingConsents.length, 1);
  assert.equal(teacherView.recordingConsents[0].consent, false);
});

test('always_allowed: starting the class turns recording on with the consent rule', async () => {
  await save(owner, { classroom: { recordingPolicy: 'always_allowed', requireStudentConsent: true } });
  await LiveClassSession.updateOne({ _id: session._id }, { $set: { status: 'scheduled' } });
  await invoke(liveClass.start, { user: teacher, params: { id: session.id } });
  const started = await LiveClassSession.findById(session._id);
  assert.equal(started.recording, true);
  assert.equal(started.recordingConsentRequired, true);
});
