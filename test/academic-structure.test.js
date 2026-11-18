// Client scope Section 8 (master 15A.5, 15A.8, 15D.3) and 8.1: academic structure, the admitted
// student's links and student ID, and institution courses shown only to that institution's people.
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
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const Course = require('../src/models/Course');
const academic = require('../src/controllers/academicStructure.controller');
const appCtrl = require('../src/controllers/institutionApplication.controller');
const courseCtrl = require('../src/controllers/course.controller');
const publicHome = require('../src/services/publicHome.service');

let mongo, owner, clerk, outsider, student, other, inst, otherInst, section, program;

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}
const mk = (name, roles) => User.create({ fullName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@as.test`, passwordHash: 'x', roles, emailVerified: true });

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await mk('Owner', ['institution_owner']);
  clerk = await mk('Clerk', ['institution_staff']);
  outsider = await mk('Outsider', ['institution_owner']);
  student = await mk('Student One', ['student']);
  other = await mk('Student Two', ['student']);
  inst = await Institution.create({ name: 'Bright Future College', slug: 'bfc', type: 'college', country: 'PK', owner: owner._id, verificationStatus: 'approved', status: 'active', staff: [{ user: clerk._id, role: 'receptionist', permissions: ['communication:send'] }] });
  otherInst = await Institution.create({ name: 'Other School', slug: 'other', type: 'school', country: 'PK', owner: outsider._id, verificationStatus: 'approved', status: 'active' });
  section = await ClassSection.create({ institution: inst._id, name: 'BSCS 1 - A' });
  program = await InstitutionProgram.create({ institution: inst._id, name: 'BSCS', department: 'Computer Science', classSection: section._id, totalTuitionFee: 100000, createdBy: owner._id });
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('the owner builds faculty > department > term > subject; links stay inside the institution', async () => {
  const call = (user, method, kind, body = {}, unitId) => invoke(academic[method], { user, params: { id: String(inst._id), kind, unitId }, body });
  const faculty = (await call(owner, 'create', 'faculties', { name: 'Faculty of Science' })).body.data;
  const dept = await call(owner, 'create', 'departments', { name: 'Computer Science', faculty: faculty._id });
  assert.equal(dept.status, 201, dept.body.message);
  const term = (await call(owner, 'create', 'terms', { name: 'Semester 1', program: program._id, order: 1 })).body.data;
  const subject = await call(owner, 'create', 'subjects', { name: 'Programming Fundamentals', code: 'CS101', department: dept.body.data._id, program: program._id, term: term._id, creditHours: 3 });
  assert.equal(subject.status, 201, subject.body.message);
  // Another institution's record cannot be linked.
  const foreign = await ClassSection.create({ institution: otherInst._id, name: 'Other class' });
  assert.equal((await call(owner, 'create', 'subjects', { name: 'X', classSection: foreign._id })).status, 422);
  // Staff without the permission can read but not change; outsiders cannot even read.
  assert.equal((await call(clerk, 'list', 'subjects')).status, 200);
  assert.equal((await call(clerk, 'create', 'subjects', { name: 'Y' })).status, 403);
  assert.equal((await call(outsider, 'list', 'subjects')).status, 403);
  // A department that still has subjects cannot be deleted.
  assert.equal((await call(owner, 'remove', 'departments', {}, String(dept.body.data._id))).status, 409);
});

test('an admitted student is linked to program, term, class and subjects and gets a student ID', async () => {
  for (const [u, n] of [[student, 1], [other, 2]]) {
    const application = await InstitutionApplication.create({ institution: inst._id, applicant: u._id, program: 'BSCS', status: 'submitted', submittedAt: new Date() });
    const r = await invoke(appCtrl.acceptAndEnroll, { user: owner, params: { id: String(application._id) } });
    assert.equal(r.status, 200, r.body.message);
    const m = await StudentInstitutionMembership.findOne({ student: u._id, institution: inst._id }).lean();
    assert.equal(m.studentId, `BFC-${new Date().getFullYear()}-000${n}`);
    assert.equal(String(m.programRef), String(program._id));
    assert.equal(String(m.classSection), String(section._id));
    assert.ok(m.term, 'first term linked');
    assert.equal(m.subjects.length, 1);
    assert.equal((await StudentProfile.findOne({ user: u._id }).lean()).rollNumber, m.studentId);
  }
});

test('8.1: institution courses are listed only to that institution\'s people; independent courses stay public', async () => {
  await Course.create([
    { title: 'BFC Physics', teacher: owner._id, institution: inst._id, classSection: section._id, published: true, isFree: true },
    { title: 'Other School Maths', teacher: outsider._id, institution: otherInst._id, published: true, isFree: true },
    { title: 'Independent English', teacher: owner._id, institution: null, published: true, isFree: true }
  ]);
  const titles = async (user) => (await invoke(courseCtrl.listCourses, { user })).body.data.map((c) => c.title).sort();
  assert.deepEqual(await titles(undefined), ['Independent English']);
  assert.deepEqual(await titles(student), ['BFC Physics', 'Independent English']);
  assert.deepEqual(await titles(outsider), ['Independent English', 'Other School Maths']);
  const home = await publicHome.listCourses({});
  assert.ok(!home.items.some((c) => c.institution), 'the public catalogue lists no institution course');
});

test('promotion moves the student\'s term, section and subjects to the new class', async () => {
  const { AcademicTerm, Subject } = require('../src/models/AcademicUnit');
  const people = require('../src/controllers/institutionPeople.controller');
  const term2 = await AcademicTerm.create({ institution: inst._id, program: program._id, name: 'Semester 2', order: 2 });
  const next = await ClassSection.create({ institution: inst._id, name: 'BSCS 2 - A', program: program._id, term: term2._id });
  const dsa = await Subject.create({ institution: inst._id, name: 'Data Structures', classSection: next._id });
  const r = await invoke(people.promote, { user: owner, params: { id: String(inst._id) }, body: { action: 'promote', fromSection: String(section._id), toSection: String(next._id) } });
  assert.equal(r.status, 201, r.body.message);
  const m = await StudentInstitutionMembership.findOne({ student: student._id, institution: inst._id }).lean();
  assert.equal(String(m.classSection), String(next._id));
  assert.equal(String(m.term), String(term2._id));
  assert.deepEqual(m.subjects.map(String), [String(dsa._id)]);
  assert.ok(m.studentId.startsWith('BFC-'), 'the student ID does not change on promotion');
});

test('master 15A.11: sessions, one current; a promoted student is linked to the current session', async () => {
  const { AcademicSession } = require('../src/models/AcademicUnit');
  const call = (method, kind, body = {}, unitId) => invoke(academic[method], { user: owner, params: { id: String(inst._id), kind, unitId }, body });
  const a = (await call('create', 'sessions', { name: '2026-2027', kind: 'year', current: true })).body.data;
  const b = (await call('create', 'sessions', { name: 'Fall 2026', kind: 'fall', current: true })).body.data;
  assert.equal((await AcademicSession.findById(a._id)).current, false, 'only one current session');
  assert.equal((await call('create', 'sessions', { name: 'X', kind: 'winter' })).status, 422);
  const { linkStudentToSection } = require('../src/utils/academicLink');
  const sec = await ClassSection.findOne({ name: 'BSCS 2 - A' });
  await linkStudentToSection(other._id, inst._id, sec._id);
  const m = await StudentInstitutionMembership.findOne({ student: other._id, institution: inst._id }).lean();
  assert.equal(String(m.session), String(b._id));
});

test('master 8.4 / 15D.21: vision, mission, history, principal message, gallery, language and uniform', async () => {
  const { applyProfileExtras, publicProfileExtras } = require('../src/utils/institutionProfile');
  const doc = await Institution.findById(inst._id);
  applyProfileExtras(doc, { vision: 'Quality education', mission: 'Every child learns', history: 'Founded 1998', schoolLanguage: 'English and Urdu', uniform: 'White shirt, grey trousers', principalMessage: { name: 'Dr. Ayesha', title: 'Principal', message: 'Welcome' }, gallery: [{ url: 'https://res.cloudinary.com/demo/a.jpg', caption: 'Campus' }] });
  await doc.save();
  const pub = publicProfileExtras((await Institution.findById(inst._id).lean()));
  assert.equal(pub.vision, 'Quality education');
  assert.equal(pub.principalMessage.name, 'Dr. Ayesha');
  assert.equal(pub.gallery[0].caption, 'Campus');
  assert.equal(pub.schoolLanguage, 'English and Urdu');
  assert.equal(pub.uniform, 'White shirt, grey trousers');
  assert.throws(() => applyProfileExtras(doc, { gallery: [{ url: 'http://insecure.example/a.jpg' }] }), /https/);
});
