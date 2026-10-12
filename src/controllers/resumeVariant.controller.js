const Resume = require('../models/Resume');
const ResumeVariant = require('../models/ResumeVariant');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const autofill = require('../services/resumeAutofill.service');

const CONTENT = ['headline', 'summary', 'location', 'education', 'experience', 'skills', 'languages', 'certifications', 'portfolio'];
const pick = (src) => Object.fromEntries(CONTENT.filter((k) => src?.[k] !== undefined).map((k) => [k, src[k]]));

async function own(req) {
  const row = await ResumeVariant.findOne({ _id: req.params.id, user: req.user._id });
  if (!row) throw new AppError('CV version not found.', 404);
  return row;
}

// GET /api/resumes/autofill — what CareerZ can fill from your own records.
const preview = asyncHandler(async (req, res) => ok(res, await autofill.draftFor(req.user)));

// POST /api/resumes/me/autofill — fill empty parts of the main CV.
const fillMain = asyncHandler(async (req, res) => {
  const resume = (await Resume.findOne({ user: req.user._id })) || new Resume({ user: req.user._id });
  const added = autofill.mergeInto(resume, await autofill.draftFor(req.user));
  await resume.save();
  return ok(res, { resume, added }, Object.keys(added).length ? 'CV filled from your records.' : 'Nothing new to add from your records.');
});

// GET /api/resumes/variants
const list = asyncHandler(async (req, res) => ok(res, await ResumeVariant.find({ user: req.user._id }).sort({ isDefault: -1, updatedAt: -1 })));

// POST /api/resumes/variants — { name, targetRole, jobId, from: 'main'|'blank'|'autofill'|<variantId> }
const create = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 80) throw new AppError('Give this CV version a name (max 80 characters).', 422);
  if ((await ResumeVariant.countDocuments({ user: req.user._id })) >= ResumeVariant.MAX_VARIANTS) throw new AppError(`You can keep up to ${ResumeVariant.MAX_VARIANTS} CV versions. Delete one first.`, 409);
  const from = String(req.body.from || 'main');
  let content = {};
  if (from === 'main') content = pick((await Resume.findOne({ user: req.user._id }).lean()) || {});
  else if (from === 'autofill') { const draft = await autofill.draftFor(req.user); delete draft.sources; content = pick(draft); }
  else if (from !== 'blank') { const src = await ResumeVariant.findOne({ _id: from, user: req.user._id }).lean(); if (!src) throw new AppError('CV version to copy was not found.', 404); content = pick(src); }
  let job = null;
  if (req.body.jobId) { job = await require('../models/Job').findById(req.body.jobId).select('_id title'); if (!job) throw new AppError('Job not found.', 404); }
  const first = !(await ResumeVariant.exists({ user: req.user._id }));
  try {
    const row = await ResumeVariant.create({ ...content, user: req.user._id, name, targetRole: String(req.body.targetRole || job?.title || '').trim().slice(0, 120), job: job?._id || null, isDefault: first });
    return created(res, row, 'CV version created.');
  } catch (e) { if (e.code === 11000) throw new AppError('You already have a CV version with this name.', 409); throw e; }
});

// PATCH /api/resumes/variants/:id
const update = asyncHandler(async (req, res) => {
  const row = await own(req);
  if (req.body.name !== undefined) { const name = String(req.body.name).trim(); if (!name || name.length > 80) throw new AppError('Name is required (max 80 characters).', 422); row.name = name; }
  if (req.body.targetRole !== undefined) row.targetRole = String(req.body.targetRole).trim().slice(0, 120);
  Object.assign(row, pick(req.body));
  try { await row.save(); } catch (e) { if (e.code === 11000) throw new AppError('You already have a CV version with this name.', 409); throw e; }
  return ok(res, row, 'CV version saved.');
});

// POST /api/resumes/variants/:id/autofill — fill this version's empty parts from your records.
const fillVariant = asyncHandler(async (req, res) => {
  const row = await own(req);
  const added = autofill.mergeInto(row, await autofill.draftFor(req.user));
  await row.save();
  return ok(res, { variant: row, added }, Object.keys(added).length ? 'CV version filled from your records.' : 'Nothing new to add from your records.');
});

// POST /api/resumes/variants/:id/default
const makeDefault = asyncHandler(async (req, res) => {
  const row = await own(req);
  await ResumeVariant.updateMany({ user: req.user._id, _id: { $ne: row._id } }, { isDefault: false });
  row.isDefault = true; await row.save();
  return ok(res, row, 'Default CV updated.');
});

// DELETE /api/resumes/variants/:id
const remove = asyncHandler(async (req, res) => {
  const row = await own(req);
  await row.deleteOne();
  if (row.isDefault) { const next = await ResumeVariant.findOne({ user: req.user._id }).sort({ updatedAt: -1 }); if (next) { next.isDefault = true; await next.save(); } }
  return ok(res, null, 'CV version deleted.');
});

module.exports = { preview, fillMain, list, create, update, fillVariant, makeDefault, remove };
