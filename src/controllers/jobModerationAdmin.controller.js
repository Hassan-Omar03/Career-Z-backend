const mongoose = require('mongoose');
const Job = require('../models/Job');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const publishing = require('../services/jobPublishing.service');

// Admin Job Review queue (Master 12.5 "Admin Review → Approve"): jobs the risk scan held.

// GET /api/admin/jobs/review?status=pending_review|rejected|active
const listForReview = asyncHandler(async (req, res) => {
  const status = ['pending_review', 'rejected', 'active'].includes(req.query.status) ? req.query.status : 'pending_review';
  const jobs = await Job.find({ status, ...(status === 'active' ? { 'moderation.reviewedBy': { $ne: null } } : {}) })
    .populate('postedBy', 'fullName email roles').populate('institution', 'name city').populate('moderation.reviewedBy', 'fullName')
    .sort({ 'moderation.submittedAt': -1, createdAt: -1 }).limit(200).lean();
  return ok(res, jobs);
});

// POST /api/admin/jobs/:id/decision { decision: 'approve' | 'reject', note }
const decide = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Job not found.', 404);
  const { decision, note } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) throw new AppError('decision must be approve or reject.', 422);
  if (decision === 'reject' && !String(note || '').trim()) throw new AppError('Write the reason, so the publisher knows what to fix.', 422);
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  if (job.status !== 'pending_review') throw new AppError('Only a job waiting for review can be decided.', 409);
  await publishing.review(job, req.user, decision, note);
  return ok(res, job, decision === 'approve' ? 'Job approved and published.' : 'Job rejected; the publisher was told why.');
});

module.exports = { listForReview, decide };
