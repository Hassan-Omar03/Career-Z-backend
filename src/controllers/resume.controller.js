const Resume = require('../models/Resume');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// GET /api/resumes/me
const getMyResume = asyncHandler(async (req, res) => {
  let resume = await Resume.findOne({ user: req.user._id });
  if (!resume) resume = await Resume.create({ user: req.user._id });
  return ok(res, resume);
});

// PATCH /api/resumes/me
const updateMyResume = asyncHandler(async (req, res) => {
  const allowed = ['headline', 'summary', 'education', 'experience', 'skills', 'languages', 'certifications', 'location', 'experienceLevel', 'linkedinUrl', 'portfolio', 'cvFileUrl', 'isPublic'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const resume = await Resume.findOneAndUpdate(
    { user: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, resume);
});

// GET /api/resumes/public/:userId (public) — a shareable Career Portfolio link. Only returns
// data when the owner has explicitly turned isPublic on; otherwise 404, same as "not found"
// rather than leaking that a private portfolio exists at that ID.
const getPublicResume = asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({ user: req.params.userId, isPublic: true }).populate('user', 'fullName profilePhoto country');
  if (!resume) throw new AppError('Portfolio not found or not public.', 404);
  const { headline, summary, location, experienceLevel, linkedinUrl, portfolio, education, experience, skills, languages, certifications, user } = resume;
  return ok(res, { headline, summary, location, experienceLevel, linkedinUrl, portfolio, education, experience, skills, languages, certifications, user });
});

module.exports = { getMyResume, updateMyResume, getPublicResume };
