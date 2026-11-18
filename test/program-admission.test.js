// Point 22 (client scope): program-based admission — levels open for admission per intake, subject
// groups with compulsory and elective subjects, the application check, enrolment with the chosen
// subjects, fee clearance before access, repeat suggestion on promotion and student-ID back-fill.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const InstitutionProgram = require('../src/models/InstitutionProgram');
const InstitutionApplication = require('../src/models/InstitutionApplication');
const Membership = require('../src/models/StudentInstitutionMembership');
const Fee = require('../src/models/Fee');
const { AcademicSession, AcademicTerm, Subject, SubjectGroup } = require('../src/models/AcademicUnit');
const academic = require('../src/controllers/academicStructure.controller');
const appCtrl = require('../src/controllers/institutionApplication.controller');
const options = require('../src/services/admissionOptions.service');
const { assertFeeAccessForCapability } = require('../src/utils/feeAccess');

let mongo, owner, student, inst, section, program, nine, ten, fall, science, arts, phy, chem, bio, cs, eng, urdu;
function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}
const mk = (name, roles) => User.create({ fullName: name, email: `${name.toLowerCase().replace(/\s/g, '')}@pa.test`, passwordHash: 'x', roles, emailVerified: true });
const unit = (kind, body) => invoke(academic.create, { user: owner, params: { id: String(inst._id), kind }, body }).then((r) => { assert.equal(r.status, 201, r.body.message); return r.body.data; });

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await mk('Owner', ['institution_owner']);
  student = await mk('Ali Khan', ['student']);
  inst = await Institution.create({ name: 'City Model School', slug: 'cms', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved', status: 'active' });
  section = await ClassSection.create({ institution: inst._id, name: 'Grade 9 - A' });
  program = await InstitutionProgram.create({ institution: inst._id, name: 'Matric', department: 'Secondary', classSection: section._id, totalTuitionFee: 60000, admissionFee: 5000, currency: 'PKR', createdBy: owner._id });
  fall = await unit('sessions', { name: '2026 Intake', kind: 'fall', current: true });
  nine = await unit('terms', { name: 'Grade 9', program: program._id, order: 1, admissionStatus: 'open', intake: fall._id, admissionDeadline: new Date(Date.now() + 864e5 * 30) });
  ten = await unit('terms', { name: 'Grade 10', program: program._id, order: 2, admissionStatus: 'upcoming' });
  [phy, chem, bio, cs, eng, urdu] = await Promise.all(['Physics', 'Chemistry', 'Biology', 'Computer Science', 'English', 'Urdu'].map((name) => unit('subjects', { name, program: program._id, term: nine._id })));
  science = await unit('groups', { name: 'Science', program: program._id, term: nine._id, compulsory: [eng._id, urdu._id, phy._id, chem._id], electives: [bio._id, cs._id], minElectives: 1, maxElectives: 1, guidance: 'Biology for medicine, Computer Science for engineering.' });
  arts = await unit('groups', { name: 'Arts', program: program._id, term: nine._id, compulsory: [eng._id, urdu._id], electives: [] });
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('groups are checked: no subject both compulsory and elective, min not above max', async () => {
  const bad = await invoke(academic.create, { user: owner, params: { id: String(inst._id), kind: 'groups' }, body: { name: 'X', term: nine._id, compulsory: [phy._id], electives: [phy._id] } });
  assert.equal(bad.status, 422);
  const bad2 = await invoke(academic.create, { user: owner, params: { id: String(inst._id), kind: 'groups' }, body: { name: 'Y', term: nine._id, electives: [bio._id], minElectives: 2, maxElectives: 1 } });
  assert.equal(bad2.status, 422);
});

test('admission options show open and upcoming levels with their groups', async () => {
  const [p] = await options.optionsFor(inst._id);
  assert.equal(p.name, 'Matric');
  assert.deepEqual(p.levels.map((l) => [l.name, l.admissionStatus]), [['Grade 9', 'open'], ['Grade 10', 'upcoming']]);
  assert.equal(p.levels[0].intake.name, '2026 Intake');
  const sci = p.levels[0].groups.find((g) => g.name === 'Science');
  assert.deepEqual(sci.compulsory.map((s) => s.name), ['English', 'Urdu', 'Physics', 'Chemistry']);
  assert.deepEqual(sci.electives.map((s) => s.name), ['Biology', 'Computer Science']);
});

test('the application must pick an open level, a group and a valid number of electives', async () => {
  const apply = (body) => invoke(appCtrl.createApplication, { user: student, body: { institution: String(inst._id), program: 'Matric', submit: true, ...body } });
  assert.match((await apply({})).body.message, /Choose the class/);
  assert.match((await apply({ term: ten._id })).body.message, /not open yet/);
  assert.match((await apply({ term: nine._id })).body.message, /subject group/);
  assert.match((await apply({ term: nine._id, subjectGroup: science._id, electives: [] })).body.message, /exactly 1/);
  assert.match((await apply({ term: nine._id, subjectGroup: science._id, electives: [bio._id, cs._id] })).body.message, /exactly 1/);
  assert.match((await apply({ term: nine._id, subjectGroup: science._id, electives: [eng._id] })).body.message, /not offered/);
  const ok = await apply({ term: nine._id, subjectGroup: science._id, electives: [bio._id] });
  assert.equal(ok.status, 201, ok.body.message);
  assert.equal(String(ok.body.data.session), String(fall._id));
  assert.equal(ok.body.data.subjects.length, 5);
});

test('after the deadline the level no longer takes applications', async () => {
  await AcademicTerm.updateOne({ _id: nine._id }, { $set: { admissionDeadline: new Date(Date.now() - 864e5) } });
  const other = await mk('Late Applicant', ['student']);
  const r = await invoke(appCtrl.createApplication, { user: other, body: { institution: String(inst._id), program: 'Matric', submit: true, term: nine._id, subjectGroup: arts._id, electives: [] } });
  assert.match(r.body.message, /not open/);
  await AcademicTerm.updateOne({ _id: nine._id }, { $set: { admissionDeadline: null } });
});

test('accepting enrols with the chosen subjects; access waits for the admission fee', async () => {
  const application = await InstitutionApplication.findOne({ applicant: student._id });
  const r = await invoke(appCtrl.acceptAndEnroll, { user: owner, params: { id: String(application._id) } });
  assert.equal(r.status, 200, r.body.message);
  const m = await Membership.findOne({ student: student._id, institution: inst._id }).lean();
  assert.equal(String(m.term), String(nine._id));
  assert.equal(String(m.session), String(fall._id));
  assert.deepEqual(m.subjects.map(String).sort(), [eng, urdu, phy, chem, bio].map((s) => String(s._id)).sort());
  const admissionFee = await Fee.findOne({ student: student._id, institution: inst._id, feeType: 'admission' });
  assert.ok(admissionFee, 'admission fee raised');
  await assert.rejects(() => assertFeeAccessForCapability(student._id, inst._id, 'materials'), /admission becomes active once/);
  await Fee.updateMany({ student: student._id, institution: inst._id }, { $set: { status: 'paid' } });
  await assertFeeAccessForCapability(student._id, inst._id, 'materials');
});

test('existing students without an ID get one', async () => {
  const old = await mk('Old Student', ['student']);
  await Membership.create({ student: old._id, institution: inst._id, status: 'active', joinedAt: new Date('2020-01-01') });
  const r = await invoke(academic.backfillStudentIds, { user: owner, params: { id: String(inst._id) } });
  assert.equal(r.body.data.assigned, 1);
  assert.match((await Membership.findOne({ student: old._id }).lean()).studentId, /^CMS-\d{4}-\d{4}$/);
});
