const Course = require('../models/Course');
const Lesson = require('../models/Lesson');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const Playlist = require('../models/Playlist');
require('../models/ClassSection');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// Courses whose lessons this user may browse, and which of them they manage (see drafts too).
async function browsableCourses(userId) {
  const [taught, owned, staffOf, enrolled] = await Promise.all([
    Course.find({ teacher: userId }).select('_id'),
    Institution.find({ owner: userId }).select('_id'),
    Institution.find({ 'staff.user': userId }).select('_id'),
    Enrollment.find({ student: userId, status: { $ne: 'dropped' } }).select('course')
  ]);
  const managedInstitutions = [...owned, ...staffOf].map((i) => i._id);
  const institutionCourses = managedInstitutions.length ? await Course.find({ institution: { $in: managedInstitutions } }).select('_id') : [];
  const managed = new Set([...taught, ...institutionCourses].map((c) => c._id.toString()));
  const all = new Set([...managed, ...enrolled.map((e) => e.course.toString())]);
  return { all: [...all], managed };
}

const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/resources/search?q=&subject=&grade=&semester=&teacher=&course=
// Every lesson the user can open, with filter facets (subject / grade / semester / teacher).
const searchResources = asyncHandler(async (req, res) => {
  const { all, managed } = await browsableCourses(req.user._id);
  const courseFilter = { _id: { $in: all } };
  const { q, subject, grade, semester, teacher, course } = req.query;
  if (course) courseFilter._id = all.includes(String(course)) ? course : { $in: [] };
  const courses = await Course.find(courseFilter).select('title subject level academicTerm classSection teacher institution').populate('classSection', 'name academicYear').populate('teacher', 'fullName').lean();
  const gradeOf = (c) => c.classSection?.name || c.level || '';
  const facets = {
    subjects: [...new Set(courses.map((c) => c.subject).filter(Boolean))].sort(),
    grades: [...new Set(courses.map(gradeOf).filter(Boolean))].sort(),
    semesters: [...new Set(courses.map((c) => c.academicTerm).filter(Boolean))].sort(),
    teachers: [...new Map(courses.filter((c) => c.teacher).map((c) => [c.teacher._id.toString(), { _id: c.teacher._id, fullName: c.teacher.fullName }])).values()]
  };
  const matching = courses.filter((c) => (!subject || c.subject === subject) && (!grade || gradeOf(c) === grade)
    && (!semester || c.academicTerm === semester) && (!teacher || c.teacher?._id.toString() === String(teacher)));
  const byId = new Map(matching.map((c) => [c._id.toString(), c]));
  const lessonFilter = { course: { $in: [...byId.keys()] } };
  if (q) lessonFilter.title = new RegExp(escape(q), 'i');
  const lessons = await Lesson.find(lessonFilter).select('title kind videoUrl resources published approvalStatus course metadata.aiAssisted metadata.department').sort({ course: 1, order: 1 }).limit(500).lean();
  const rows = lessons
    .filter((l) => managed.has(l.course.toString()) || (l.published !== false && ['approved', undefined].includes(l.approvalStatus)))
    .map((l) => {
      const c = byId.get(l.course.toString());
      return { _id: l._id, title: l.title, kind: l.kind, videoUrl: l.videoUrl, resources: l.resources || [], aiAssisted: Boolean(l.metadata?.aiAssisted), department: l.metadata?.department || '',
        course: { _id: c._id, title: c.title, subject: c.subject, academicTerm: c.academicTerm, grade: gradeOf(c) }, teacher: c.teacher ? { _id: c.teacher._id, fullName: c.teacher.fullName } : null };
    });
  return ok(res, { facets, lessons: rows });
});

// ---- Playlists ----

async function institutionMembership(userId) {
  const [owned, staffOf, teacher, profile, memberships] = await Promise.all([
    Institution.find({ owner: userId }).select('_id'), Institution.find({ 'staff.user': userId }).select('_id'),
    TeacherProfile.findOne({ user: userId }).select('institutions'), StudentProfile.findOne({ user: userId }).select('primaryInstitution'),
    StudentInstitutionMembership.find({ student: userId, status: 'active' }).select('institution')
  ]);
  return new Set([...owned, ...staffOf].map((i) => i._id.toString())
    .concat((teacher?.institutions || []).map(String), profile?.primaryInstitution ? [profile.primaryInstitution.toString()] : [], memberships.map((m) => m.institution.toString())));
}

async function canView(playlist, userId) {
  if (playlist.owner.toString() === userId.toString()) return true;
  if (playlist.visibility === 'course' && playlist.course) {
    const course = await Course.findById(playlist.course).select('teacher');
    return course?.teacher?.toString() === userId.toString() || Boolean(await Enrollment.exists({ course: playlist.course, student: userId, status: { $ne: 'dropped' } }));
  }
  if (playlist.visibility === 'institution' && playlist.institution) return (await institutionMembership(userId)).has(playlist.institution.toString());
  return false;
}

// Validates items against visibility so a shared playlist can never expose another course's lessons.
async function validatePlaylist(body, userId) {
  const visibility = ['private', 'course', 'institution'].includes(body.visibility) ? body.visibility : 'private';
  const lessonIds = [...new Set((Array.isArray(body.items) ? body.items : []).map((i) => String(i.lesson || i)))].slice(0, 200);
  const lessons = await Lesson.find({ _id: { $in: lessonIds } }).select('course');
  if (lessons.length !== lessonIds.length) throw new AppError('Some lessons no longer exist.', 422);
  const { all, managed } = await browsableCourses(userId);
  if (lessons.some((l) => !all.includes(l.course.toString()))) throw new AppError('You can only add lessons you have access to.', 403);
  let course = null, institution = null;
  if (visibility === 'course') {
    course = String(body.course || '');
    if (!managed.has(course)) throw new AppError('Share with a course you teach or manage.', 403);
    if (lessons.some((l) => l.course.toString() !== course)) throw new AppError('A course playlist can only contain that course\'s lessons.', 422);
  }
  if (visibility === 'institution') {
    institution = String(body.institution || '');
    const instCourses = new Set((await Course.find({ institution }).select('_id')).map((c) => c._id.toString()));
    const managesHere = [...managed].some((id) => instCourses.has(id));
    if (!managesHere) throw new AppError('Share with an institution where you teach or manage courses.', 403);
    if (lessons.some((l) => !instCourses.has(l.course.toString()))) throw new AppError('An institution playlist can only contain that institution\'s lessons.', 422);
  }
  const notes = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [String(i.lesson || i), String(i.note || '').slice(0, 300)]));
  const title = String(body.title || '').trim();
  if (!title) throw new AppError('Give the playlist a title.', 422);
  return { title: title.slice(0, 150), description: String(body.description || '').slice(0, 2000), visibility, course, institution, items: lessonIds.map((id) => ({ lesson: id, note: notes.get(id) || '' })) };
}

// GET /api/playlists — mine + those shared with me.
const listPlaylists = asyncHandler(async (req, res) => {
  const [enrolled, taught, memberOf] = await Promise.all([
    Enrollment.find({ student: req.user._id, status: { $ne: 'dropped' } }).distinct('course'),
    Course.find({ teacher: req.user._id }).distinct('_id'),
    institutionMembership(req.user._id)
  ]);
  const playlists = await Playlist.find({ $or: [
    { owner: req.user._id },
    { visibility: 'course', course: { $in: [...enrolled, ...taught] } },
    { visibility: 'institution', institution: { $in: [...memberOf] } }
  ] }).populate('owner', 'fullName').populate('course', 'title').sort({ updatedAt: -1 }).limit(200);
  return ok(res, playlists.map((p) => ({ ...p.toObject(), mine: p.owner._id.toString() === req.user._id.toString(), itemCount: p.items.length })));
});

// GET /api/playlists/:id — with lesson details.
const getPlaylist = asyncHandler(async (req, res) => {
  const playlist = await Playlist.findById(req.params.id).populate('owner', 'fullName').populate({ path: 'items.lesson', select: 'title kind videoUrl resources course', populate: { path: 'course', select: 'title subject' } });
  if (!playlist || !(await canView(playlist, req.user._id))) throw new AppError('Playlist not found.', 404);
  return ok(res, playlist);
});

const createPlaylist = asyncHandler(async (req, res) => {
  const playlist = await Playlist.create({ ...(await validatePlaylist(req.body || {}, req.user._id)), owner: req.user._id });
  return created(res, playlist, 'Playlist created.');
});

const updatePlaylist = asyncHandler(async (req, res) => {
  const playlist = await Playlist.findById(req.params.id);
  if (!playlist || playlist.owner.toString() !== req.user._id.toString()) throw new AppError('Playlist not found.', 404);
  const merged = { title: playlist.title, description: playlist.description, visibility: playlist.visibility, course: playlist.course, institution: playlist.institution, items: playlist.items.map((i) => ({ lesson: i.lesson, note: i.note })), ...req.body };
  Object.assign(playlist, await validatePlaylist(merged, req.user._id));
  await playlist.save();
  return ok(res, playlist, 'Playlist saved.');
});

const deletePlaylist = asyncHandler(async (req, res) => {
  const result = await Playlist.deleteOne({ _id: req.params.id, owner: req.user._id });
  if (!result.deletedCount) throw new AppError('Playlist not found.', 404);
  return ok(res, { deleted: true }, 'Playlist deleted.');
});

module.exports = { searchResources, listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist };
