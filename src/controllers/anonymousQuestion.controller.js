const AnonymousQuestion = require('../models/AnonymousQuestion');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

// Distinguishes "runs the institution" (owner, or staff whose role isn't 'teacher') from "teaches
// here" — the former sees every question institution-wide (oversight role), the latter only ever
// sees questions asked about a class they actually teach (see institutionQuestions/answerQuestion).
async function institutionRole(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isNonTeachingStaff = institution.staff.some((s) => s.user.toString() === userId.toString() && s.role !== 'teacher');
  const teacherProfile = await TeacherProfile.findOne({ user: userId });
  const isTeacherHere = Boolean(teacherProfile && teacherProfile.institutions.some((i) => i.toString() === institutionId.toString()));
  if (!isOwner && !isNonTeachingStaff && !isTeacherHere) throw new AppError('You are not part of this institution.', 403);
  return { isOwner, isNonTeachingStaff, isTeacherHere, hasFullAccess: isOwner || isNonTeachingStaff };
}

// Strips the asker's identity before any teacher/institution-facing response leaves the server.
function hideAsker(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  const { student, ...safe } = obj;
  return safe;
}

// POST /api/anonymous-questions (student only) — tied to one of the student's own actively
// enrolled courses, so the teacher who eventually answers it can be scoped to that class.
const createQuestion = asyncHandler(async (req, res) => {
  const { course: courseId, subject, question } = req.body;
  if (!courseId || !question) throw new AppError('course and question are required.', 422);

  const enrollment = await Enrollment.findOne({ student: req.user._id, course: courseId, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);

  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found.', 404);

  const profile = await StudentProfile.findOne({ user: req.user._id });
  const institutionId = course.institution || profile?.primaryInstitution;
  if (!institutionId) throw new AppError('This course is not linked to an institution.', 422);

  const q = await AnonymousQuestion.create({
    institution: institutionId,
    student: req.user._id,
    course: course._id,
    subject: subject || '',
    question
  });
  return created(res, q, 'Question submitted anonymously.');
});

// GET /api/anonymous-questions/mine (student) — full record, including the answer.
const myQuestions = asyncHandler(async (req, res) => {
  const list = await AnonymousQuestion.find({ student: req.user._id }).sort({ createdAt: -1 }).populate('course', 'title subject');
  return ok(res, list);
});

// GET /api/anonymous-questions/institution (teacher/institution staff/owner) — asker hidden.
// A teacher only ever sees questions asked about a course they actually teach; institution owner
// or non-teaching staff see every question institution-wide (oversight).
const institutionQuestions = asyncHandler(async (req, res) => {
  const { institutionId } = req.query;
  if (!institutionId) throw new AppError('institutionId is required.', 422);
  const role = await institutionRole(institutionId, req.user._id);

  const filter = { institution: institutionId };
  if (!role.hasFullAccess) {
    const ownCourseIds = await Course.find({ teacher: req.user._id }).distinct('_id');
    filter.course = { $in: ownCourseIds };
  }

  const list = await AnonymousQuestion.find(filter).sort({ createdAt: -1 }).populate('course', 'title subject');
  return ok(res, list.map(hideAsker));
});

// PATCH /api/anonymous-questions/:id/answer (teacher/institution staff/owner)
const answerQuestion = asyncHandler(async (req, res) => {
  const { answer } = req.body;
  if (!answer) throw new AppError('answer is required.', 422);

  const question = await AnonymousQuestion.findById(req.params.id);
  if (!question) throw new AppError('Question not found.', 404);
  const role = await institutionRole(question.institution, req.user._id);

  if (!role.hasFullAccess) {
    const course = await Course.findById(question.course);
    if (!course || course.teacher.toString() !== req.user._id.toString()) {
      throw new AppError('You can only answer questions asked about a class you teach.', 403);
    }
  }

  question.answer = answer;
  question.answeredBy = req.user._id;
  question.status = 'answered';
  await question.save();

  await notify(question.student, {
    title: 'Your anonymous question was answered',
    body: answer.slice(0, 140),
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, hideAsker(question), 'Answer submitted.');
});

module.exports = { createQuestion, myQuestions, institutionQuestions, answerQuestion };
