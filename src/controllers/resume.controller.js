const Resume = require('../models/Resume');
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
  const allowed = ['headline', 'summary', 'education', 'experience', 'skills', 'languages', 'certifications'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const resume = await Resume.findOneAndUpdate(
    { user: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, resume);
});

module.exports = { getMyResume, updateMyResume };
