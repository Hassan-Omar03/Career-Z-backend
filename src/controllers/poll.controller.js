const Poll = require('../models/Poll');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

async function institutionRole(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isNonTeachingStaff = institution.staff.some((s) => s.user.toString() === userId.toString() && s.role !== 'teacher');
  const teacherProfile = await TeacherProfile.findOne({ user: userId });
  const isTeacherHere = Boolean(teacherProfile && teacherProfile.institutions.some((i) => i.toString() === institutionId.toString()));
  if (!isOwner && !isNonTeachingStaff && !isTeacherHere) throw new AppError('You are not part of this institution.', 403);
  return { hasFullAccess: isOwner || isNonTeachingStaff };
}

// Adds a `percent` alongside each option's raw vote count — every screen showing poll results
// wants this, so it belongs here once rather than recomputed by each caller.
function withPercent(poll) {
  const obj = poll.toObject ? poll.toObject() : poll;
  const total = obj.options.reduce((sum, o) => sum + o.votes, 0);
  obj.options = obj.options.map((o) => ({ ...o, percent: total > 0 ? Math.round((o.votes / total) * 100) : 0 }));
  obj.totalVotes = total;
  return obj;
}

// POST /api/polls (teacher/institution) — a course-scoped poll only reaches that course's own
// enrolled students; omitting course makes an institution-wide poll, which only the institution
// owner/non-teaching staff may create (a teacher can't broadcast to the whole institution).
const createPoll = asyncHandler(async (req, res) => {
  const { institution: institutionIdBody, question, options, course: courseId } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2) {
    throw new AppError('question and at least 2 options are required.', 422);
  }

  let institutionId = institutionIdBody;
  let classSection = null;
  if (courseId) {
    const course = await Course.findById(courseId);
    if (!course) throw new AppError('Course not found.', 404);
    if (course.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);
    institutionId = course.institution || institutionId;
    classSection = course.classSection || null;
  }
  if (!institutionId) throw new AppError('institution is required.', 422);

  const role = await institutionRole(institutionId, req.user._id);
  if (!courseId && !role.hasFullAccess) {
    throw new AppError('Only the institution can create an institution-wide poll — pick a class to scope this poll to one of your own courses instead.', 403);
  }

  const poll = await Poll.create({
    institution: institutionId,
    createdBy: req.user._id,
    course: courseId || null,
    classSection,
    question,
    options: options.map((text) => ({ text, votes: 0 }))
  });
  return created(res, withPercent(poll), 'Poll created.');
});

// GET /api/polls/mine (teacher/institution) — polls this user created.
const myPolls = asyncHandler(async (req, res) => {
  const polls = await Poll.find({ createdBy: req.user._id }).sort({ createdAt: -1 }).populate('course', 'title');
  return ok(res, polls.map(withPercent));
});

// GET /api/polls/available (student) — open polls for the student's institution: institution-wide
// ones, plus course-scoped ones only for courses this student is actively enrolled in.
const availablePolls = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile || !profile.primaryInstitution) return ok(res, []);

  const enrolledCourseIds = await Enrollment.find({ student: req.user._id, status: { $ne: 'dropped' } }).distinct('course');
  const polls = await Poll.find({
    institution: profile.primaryInstitution,
    status: 'open',
    $or: [{ course: null }, { course: { $in: enrolledCourseIds } }]
  }).sort({ createdAt: -1 }).populate('course', 'title');

  const withVoted = polls.map((p) => {
    const mine = p.votedBy.find((v) => v.user.toString() === req.user._id.toString());
    const obj = withPercent(p);
    obj.myVote = mine ? mine.optionIndex : null;
    return obj;
  });
  return ok(res, withVoted);
});

// POST /api/polls/:id/vote (student)
const vote = asyncHandler(async (req, res) => {
  const { optionIndex } = req.body;
  const poll = await Poll.findById(req.params.id);
  if (!poll) throw new AppError('Poll not found.', 404);
  if (poll.status !== 'open') throw new AppError('This poll is closed.', 400);
  if (optionIndex === undefined || !poll.options[optionIndex]) throw new AppError('Invalid option.', 422);

  if (poll.course) {
    const enrolled = await Enrollment.findOne({ student: req.user._id, course: poll.course, status: { $ne: 'dropped' } });
    if (!enrolled) throw new AppError('This poll is for a class you are not enrolled in.', 403);
  }

  const already = poll.votedBy.find((v) => v.user.toString() === req.user._id.toString());
  if (already) throw new AppError('You already voted on this poll.', 400);

  poll.options[optionIndex].votes += 1;
  poll.votedBy.push({ user: req.user._id, optionIndex });
  await poll.save();
  return ok(res, withPercent(poll), 'Vote recorded.');
});

// PATCH /api/polls/:id/close (creator)
const closePoll = asyncHandler(async (req, res) => {
  const poll = await Poll.findById(req.params.id);
  if (!poll) throw new AppError('Poll not found.', 404);
  if (poll.createdBy.toString() !== req.user._id.toString()) throw new AppError('Only the creator can close this poll.', 403);

  poll.status = 'closed';
  await poll.save();
  return ok(res, withPercent(poll), 'Poll closed.');
});

module.exports = { createPoll, myPolls, availablePolls, vote, closePoll };
