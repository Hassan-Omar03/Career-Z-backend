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
  const allowed = ['headline', 'summary', 'education', 'experience', 'skills', 'languages', 'certifications', 'location', 'experienceLevel', 'linkedinUrl', 'portfolio', 'cvFileUrl', 'isPublic', 'template'];
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
// POST /api/resumes/me/cv-file { name, data } · DELETE · GET (the owner's own file)
const cvChoice = require('../services/cvChoice.service');
const sendPrivateFile = (res, file) => {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(file.data);
};
const uploadCvFile = asyncHandler(async (req, res) => ok(res, await cvChoice.upload(req.user._id, req.body || {}), 'CV uploaded.'));
const removeCvFile = asyncHandler(async (req, res) => ok(res, await cvChoice.remove(req.user._id), 'CV file removed.'));
const downloadCvFile = asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({ user: req.user._id }).select('cvFile');
  const file = resume?.cvFile ? await require('../models/PrivateFile').findById(resume.cvFile) : null;
  if (!file) throw new AppError('No CV file uploaded.', 404);
  return sendPrivateFile(res, file);
});

const getPublicResume = asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({ user: req.params.userId, isPublic: true }).populate('user', 'fullName profilePhoto country');
  if (!resume) throw new AppError('Portfolio not found or not public.', 404);
  const { headline, summary, location, experienceLevel, linkedinUrl, portfolio, education, experience, skills, languages, certifications, user } = resume;
  return ok(res, { headline, summary, location, experienceLevel, linkedinUrl, portfolio, education, experience, skills, languages, certifications, user });
});

module.exports = { uploadCvFile, removeCvFile, downloadCvFile, sendPrivateFile, getMyResume, updateMyResume, getPublicResume };
