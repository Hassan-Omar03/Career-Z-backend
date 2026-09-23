const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const InstitutionApplication = require('../src/models/InstitutionApplication');
const AdmissionTest = require('../src/models/AdmissionTest');
const ctrl = require('../src/controllers/institutionApplication.controller');

const MODELS = [User, Institution, InstitutionApplication, AdmissionTest];
let mongo, owner, student, institution, application;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(MODELS.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  owner = await User.create({ fullName: 'Owner', email: 'owner@admission.test', passwordHash: 'unused', roles: ['institution_owner'] });
  student = await User.create({ fullName: 'Student', email: 'student@admission.test', passwordHash: 'unused', roles: ['student'], emailVerified: true });
  institution = await Institution.create({ owner: owner._id, name: 'Test School', slug: `test-school-${Date.now()}`, type: 'school', country: 'PK' });
  application = await InstitutionApplication.create({ institution: institution._id, applicant: student._id, program: 'Grade 9', status: 'submitted', submittedAt: new Date() });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ user, params, body, query: {} }, res, reject)).catch(reject);
  });
}

async function createAndAssign() {
  const made = await invoke(ctrl.createOnlineTest, { user: owner, body: {
    institution: institution._id, title: 'Grade 9 Entry Test', durationMinutes: 30, passingPercent: 50, published: true,
    questions: [
      { text: '2 + 2?', options: ['3', '4', '5', '6'], correctOption: 1, marks: 2 },
      { text: 'The earth is round.', type: 'true_false', options: ['True', 'False'], correctOption: 0, marks: 1 }
    ]
  } });
  await invoke(ctrl.assignOnlineTest, { user: owner, params: { id: application._id }, body: { testId: made.body.data._id, scheduledAt: new Date(Date.now() - 1000) } });
}

test('institution creates and assigns a test; student payload never leaks correct answers', async () => {
  await createAndAssign();
  const started = await invoke(ctrl.startOnlineTest, { user: student, params: { id: application._id } });
  assert.equal(started.body.data.test.questions.length, 2);
  assert.equal('correctOption' in started.body.data.test.questions[0], false);
  assert.ok(started.body.data.endsAt);
});

test('online admission test auto-grades once and blocks premature acceptance', async () => {
  await createAndAssign();
  await assert.rejects(() => invoke(ctrl.acceptAndEnroll, { user: owner, params: { id: application._id } }), /must be passed/);
  await invoke(ctrl.startOnlineTest, { user: student, params: { id: application._id } });
  assert.ok((await InstitutionApplication.findById(application._id)).admissionTest.startedAt, 'start time must persist');
  const result = await invoke(ctrl.submitOnlineTest, { user: student, params: { id: application._id }, body: { answers: [{ questionIndex: 0, selectedOption: 1 }, { questionIndex: 1, selectedOption: 0 }] } });
  assert.deepEqual(result.body.data, { score: 3, maxScore: 3, percent: 100, passed: true });
  await assert.rejects(() => invoke(ctrl.submitOnlineTest, { user: student, params: { id: application._id }, body: { answers: [] } }), /already been submitted/);
  await assert.rejects(() => invoke(ctrl.acceptAndEnroll, { user: owner, params: { id: application._id } }), /interview must be completed/);
});
