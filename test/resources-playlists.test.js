const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const ClassSection = require('../src/models/ClassSection');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');
const Enrollment = require('../src/models/Enrollment');
const Playlist = require('../src/models/Playlist');
require('../src/models/ContentVersion');
const ctrl = require('../src/controllers/resources.controller');

const models = [User, Institution, ClassSection, Course, Lesson, Enrollment, Playlist];
let mongo, teacher, teacher2, student, outsider, institution, physics, chem, other, pLesson, pDraft, cLesson, oLesson;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  [teacher, teacher2, student, outsider] = await User.create(['t1', 't2', 'stu', 'out'].map((n) => ({ fullName: n, email: `${n}@lib.test`, passwordHash: 'x' })));
  institution = await Institution.create({ name: 'Uni', slug: 'uni-lib', type: 'school', country: 'PK', owner: teacher2._id });
  const g10 = await ClassSection.create({ institution: institution._id, name: 'Grade 10-A', academicYear: '2026' });
  physics = await Course.create({ title: 'Physics 10', subject: 'Physics', academicTerm: 'Term 1', classSection: g10._id, teacher: teacher._id, institution: institution._id });
  chem = await Course.create({ title: 'Chem 10', subject: 'Chemistry', academicTerm: 'Term 2', classSection: g10._id, teacher: teacher2._id, institution: institution._id });
  other = await Course.create({ title: 'Secret course', subject: 'Math', teacher: outsider._id });
  pLesson = await Lesson.create({ course: physics._id, title: 'Motion', approvalStatus: 'approved' });
  pDraft = await Lesson.create({ course: physics._id, title: 'Draft force', approvalStatus: 'draft', published: false });
  cLesson = await Lesson.create({ course: chem._id, title: 'Atoms', approvalStatus: 'approved' });
  oLesson = await Lesson.create({ course: other._id, title: 'Hidden', approvalStatus: 'approved' });
  await Enrollment.create([{ student: student._id, course: physics._id, status: 'active' }, { student: student._id, course: chem._id, status: 'active' }]);
});

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body, query }, res, reject)).catch(reject);
  });
}

test('resource search: students see published lessons of their courses with subject/grade/semester/teacher filters', async () => {
  const all = (await invoke(ctrl.searchResources, { user: student })).body.data;
  assert.deepEqual(all.lessons.map((l) => l.title).sort(), ['Atoms', 'Motion']); // no draft, no other course
  assert.deepEqual(all.facets.subjects, ['Chemistry', 'Physics']);
  assert.deepEqual(all.facets.grades, ['Grade 10-A']);
  assert.deepEqual(all.facets.semesters, ['Term 1', 'Term 2']);
  assert.equal(all.facets.teachers.length, 2);
  assert.deepEqual((await invoke(ctrl.searchResources, { user: student, query: { semester: 'Term 2' } })).body.data.lessons.map((l) => l.title), ['Atoms']);
  assert.deepEqual((await invoke(ctrl.searchResources, { user: student, query: { teacher: teacher.id } })).body.data.lessons.map((l) => l.title), ['Motion']);
  assert.deepEqual((await invoke(ctrl.searchResources, { user: student, query: { q: 'ato' } })).body.data.lessons.map((l) => l.title), ['Atoms']);
  const teacherView = (await invoke(ctrl.searchResources, { user: teacher })).body.data.lessons.map((l) => l.title).sort();
  assert.deepEqual(teacherView, ['Draft force', 'Motion']); // the course teacher sees drafts
});

test('course playlists reach that course\'s students only and cannot mix in other lessons', async () => {
  const pl = (await invoke(ctrl.createPlaylist, { user: teacher, body: { title: 'Revision', visibility: 'course', course: physics.id, items: [{ lesson: pDraft.id, note: 'read first' }, { lesson: pLesson.id }] } })).body.data;
  assert.deepEqual(pl.items.map((i) => String(i.lesson)), [pDraft.id, pLesson.id]); // order kept
  assert.equal((await invoke(ctrl.listPlaylists, { user: student })).body.data.length, 1);
  assert.equal((await invoke(ctrl.getPlaylist, { user: student, params: { id: pl._id } })).body.data.items.length, 2);
  await assert.rejects(invoke(ctrl.getPlaylist, { user: outsider, params: { id: pl._id } }), { statusCode: 404 });
  const physics2 = await Course.create({ title: 'Physics 11', teacher: teacher._id, institution: institution._id });
  const p2Lesson = await Lesson.create({ course: physics2._id, title: 'Waves', approvalStatus: 'approved' });
  await assert.rejects(invoke(ctrl.createPlaylist, { user: teacher, body: { title: 'Mixed', visibility: 'course', course: physics.id, items: [{ lesson: p2Lesson.id }] } }), { statusCode: 422 });
  await assert.rejects(invoke(ctrl.createPlaylist, { user: teacher, body: { title: 'Not mine', items: [{ lesson: cLesson.id }] } }), { statusCode: 403 });
  await assert.rejects(invoke(ctrl.createPlaylist, { user: teacher, body: { title: 'Steal', items: [{ lesson: oLesson.id }] } }), { statusCode: 403 });
  await assert.rejects(invoke(ctrl.createPlaylist, { user: student, body: { title: 'x', visibility: 'course', course: physics.id, items: [] } }), { statusCode: 403 });
});

test('students make private playlists; only the owner edits/deletes; reordering is saved', async () => {
  const pl = (await invoke(ctrl.createPlaylist, { user: student, body: { title: 'My exam prep', items: [pLesson.id, cLesson.id] } })).body.data;
  assert.equal((await invoke(ctrl.listPlaylists, { user: teacher })).body.data.length, 0); // private
  await invoke(ctrl.updatePlaylist, { user: student, params: { id: pl._id }, body: { items: [{ lesson: cLesson.id }, { lesson: pLesson.id }] } });
  assert.deepEqual((await Playlist.findById(pl._id)).items.map((i) => String(i.lesson)), [cLesson.id, pLesson.id]);
  await assert.rejects(invoke(ctrl.updatePlaylist, { user: teacher, params: { id: pl._id }, body: { title: 'hijack' } }), { statusCode: 404 });
  await assert.rejects(invoke(ctrl.deletePlaylist, { user: teacher, params: { id: pl._id } }), { statusCode: 404 });
  await invoke(ctrl.deletePlaylist, { user: student, params: { id: pl._id } });
  assert.equal(await Playlist.countDocuments(), 0);
});
