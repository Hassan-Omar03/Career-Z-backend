const Institution = require('../models/Institution');
const GradingPolicy = require('../models/GradingPolicy');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { policyFor, validatePolicy } = require('../services/grading.service');
const { assertOwnerOrPermission } = require('./staffPermission.controller');

// GET /api/institutions/:id/grading-policy — the scale students/teachers/staff see (public info).
const getPolicy = asyncHandler(async (req, res) => {
  if (!(await Institution.exists({ _id: req.params.id }))) throw new AppError('Institution not found.', 404);
  return ok(res, await policyFor(req.params.id));
});

// PUT /api/institutions/:id/grading-policy — owner, or staff with 'grading:manage'.
const savePolicy = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrPermission(institution, req.user._id, 'grading:manage');
  let clean;
  try { clean = validatePolicy(req.body || {}); } catch (error) { throw new AppError(error.message, 422); }
  await GradingPolicy.findOneAndUpdate(
    { institution: institution._id },
    { $set: { ...clean, updatedBy: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return ok(res, await policyFor(institution._id), 'Grading scale saved. New results and transcripts will use it.');
});

// DELETE /api/institutions/:id/grading-policy — back to the platform default 4.0 scale.
const resetPolicy = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrPermission(institution, req.user._id, 'grading:manage');
  await GradingPolicy.deleteOne({ institution: institution._id });
  return ok(res, await policyFor(institution._id), 'Grading scale reset to the default 4.0 scale.');
});

module.exports = { getPolicy, savePolicy, resetPolicy };
