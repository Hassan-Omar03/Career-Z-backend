const Lesson = require('../models/Lesson');
const Course = require('../models/Course');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// The course teacher edits provenance; the teacher (independent course) or the institution's
// owner/staff (institution course) can stamp a review.
async function lessonAccess(lessonId, userId) {
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);
  const course = await Course.findById(lesson.course).select('teacher institution');
  if (!course) throw new AppError('Course not found.', 404);
  const uid = userId.toString();
  const isTeacher = course.teacher.toString() === uid;
  let isInstitutionReviewer = false;
  if (course.institution) {
    const institution = await Institution.findById(course.institution).select('owner staff');
    isInstitutionReviewer = Boolean(institution) && (institution.owner.toString() === uid || institution.staff.some((s) => s.user.toString() === uid));
  }
  return { lesson, course, isTeacher, canReview: course.institution ? isInstitutionReviewer : isTeacher };
}

// GET /api/lesson-metadata/:lessonId
const getMetadata = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId).select('metadata title course').populate('metadata.author', 'fullName').populate('metadata.lastReviewedBy', 'fullName');
  if (!lesson) throw new AppError('Lesson not found.', 404);
  return ok(res, { lesson: lesson._id, title: lesson.title, ...lesson.metadata?.toObject?.() });
});

// PATCH /api/lesson-metadata/:lessonId — { authorName, department, aiAssisted, aiNote }
const updateMetadata = asyncHandler(async (req, res) => {
  const { lesson, isTeacher } = await lessonAccess(req.params.lessonId, req.user._id);
  if (!isTeacher) throw new AppError('Only the course teacher can edit lesson details.', 403);
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  if ('authorName' in req.body) lesson.set('metadata.authorName', clip(req.body.authorName, 200));
  if ('department' in req.body) lesson.set('metadata.department', clip(req.body.department, 200));
  if ('aiAssisted' in req.body) lesson.set('metadata.aiAssisted', Boolean(req.body.aiAssisted));
  if ('aiNote' in req.body) lesson.set('metadata.aiNote', clip(req.body.aiNote, 500));
  await lesson.save();
  return ok(res, lesson.metadata, 'Lesson details saved.');
});

// POST /api/lesson-metadata/:lessonId/review — "content checked and still accurate".
const markReviewed = asyncHandler(async (req, res) => {
  const { lesson, canReview } = await lessonAccess(req.params.lessonId, req.user._id);
  if (!canReview) throw new AppError('Only the teacher (independent course) or the institution\'s staff can review this lesson.', 403);
  // Direct update: a review stamp is not a content change, so no new content revision.
  await Lesson.updateOne({ _id: lesson._id }, { $set: { 'metadata.lastReviewedAt': new Date(), 'metadata.lastReviewedBy': req.user._id } });
  const refreshed = await Lesson.findById(lesson._id).select('metadata');
  return ok(res, refreshed.metadata, 'Marked as reviewed.');
});

module.exports = { getMetadata, updateMetadata, markReviewed };
