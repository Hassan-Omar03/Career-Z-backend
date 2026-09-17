const Poll = require('../models/Poll');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

async function assertInstitutionStaffOrOwner(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  const teacherProfile = await TeacherProfile.findOne({ user: userId });
  const isTeacherHere = teacherProfile && teacherProfile.institutions.some((i) => i.toString() === institutionId.toString());
  if (!isOwner && !isStaff && !isTeacherHere) throw new AppError('You are not part of this institution.', 403);
}

// POST /api/polls (teacher/institution)
const createPoll = asyncHandler(async (req, res) => {
  const { institution, question, options, classSection } = req.body;
  if (!institution || !question || !Array.isArray(options) || options.length < 2) {
    throw new AppError('institution, question and at least 2 options are required.', 422);
  }
  await assertInstitutionStaffOrOwner(institution, req.user._id);

  const poll = await Poll.create({
    institution,
    createdBy: req.user._id,
    classSection: classSection || null,
    question,
    options: options.map((text) => ({ text, votes: 0 }))
  });
  return created(res, poll, 'Poll created.');
});

// GET /api/polls/mine (teacher/institution) — polls this user created.
const myPolls = asyncHandler(async (req, res) => {
  const polls = await Poll.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
  return ok(res, polls);
});

// GET /api/polls/available (student) — open polls for the student's institution.
const availablePolls = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile || !profile.primaryInstitution) return ok(res, []);

  const polls = await Poll.find({ institution: profile.primaryInstitution, status: 'open' }).sort({ createdAt: -1 });
  const withVoted = polls.map((p) => {
    const mine = p.votedBy.find((v) => v.user.toString() === req.user._id.toString());
    const obj = p.toObject();
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

  const already = poll.votedBy.find((v) => v.user.toString() === req.user._id.toString());
  if (already) throw new AppError('You already voted on this poll.', 400);

  poll.options[optionIndex].votes += 1;
  poll.votedBy.push({ user: req.user._id, optionIndex });
  await poll.save();
  return ok(res, poll, 'Vote recorded.');
});

// PATCH /api/polls/:id/close (creator)
const closePoll = asyncHandler(async (req, res) => {
  const poll = await Poll.findById(req.params.id);
  if (!poll) throw new AppError('Poll not found.', 404);
  if (poll.createdBy.toString() !== req.user._id.toString()) throw new AppError('Only the creator can close this poll.', 403);

  poll.status = 'closed';
  await poll.save();
  return ok(res, poll, 'Poll closed.');
});

module.exports = { createPoll, myPolls, availablePolls, vote, closePoll };
