const AnonymousQuestion = require('../models/AnonymousQuestion');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

async function assertInstitutionStaffOrOwner(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  const teacherProfile = await TeacherProfile.findOne({ user: userId });
  const isTeacherHere = teacherProfile && teacherProfile.institutions.some((i) => i.toString() === institutionId.toString());
  if (!isOwner && !isStaff && !isTeacherHere) throw new AppError('You are not part of this institution.', 403);
  return institution;
}

// Strips the asker's identity before any teacher/institution-facing response leaves the server.
function hideAsker(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  const { student, ...safe } = obj;
  return safe;
}

// POST /api/anonymous-questions (student only)
const createQuestion = asyncHandler(async (req, res) => {
  const { subject, question } = req.body;
  if (!question) throw new AppError('question is required.', 422);

  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile || !profile.primaryInstitution) {
    throw new AppError('Connect to an institution before asking a question.', 422);
  }

  const q = await AnonymousQuestion.create({
    institution: profile.primaryInstitution,
    student: req.user._id,
    subject: subject || '',
    question
  });
  return created(res, q, 'Question submitted anonymously.');
});

// GET /api/anonymous-questions/mine (student) — full record, including the answer.
const myQuestions = asyncHandler(async (req, res) => {
  const list = await AnonymousQuestion.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, list);
});

// GET /api/anonymous-questions/institution (teacher/institution staff/owner) — asker hidden.
const institutionQuestions = asyncHandler(async (req, res) => {
  const { institutionId } = req.query;
  if (!institutionId) throw new AppError('institutionId is required.', 422);
  await assertInstitutionStaffOrOwner(institutionId, req.user._id);

  const list = await AnonymousQuestion.find({ institution: institutionId }).sort({ createdAt: -1 });
  return ok(res, list.map(hideAsker));
});

// PATCH /api/anonymous-questions/:id/answer (teacher/institution staff/owner)
const answerQuestion = asyncHandler(async (req, res) => {
  const { answer } = req.body;
  if (!answer) throw new AppError('answer is required.', 422);

  const question = await AnonymousQuestion.findById(req.params.id);
  if (!question) throw new AppError('Question not found.', 404);
  await assertInstitutionStaffOrOwner(question.institution, req.user._id);

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
