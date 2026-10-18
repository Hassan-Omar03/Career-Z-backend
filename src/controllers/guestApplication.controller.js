const Job = require('../models/Job');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok, created } = require('../utils/apiResponse');
const guests = require('../services/guestApplication.service');

// Guest job applications (see guestApplication.service).

// POST /api/jobs/:id/guest-apply (public)
const apply = asyncHandler(async (req, res) => {
  const job = /^[a-f0-9]{24}$/i.test(req.params.id) ? await Job.findById(req.params.id) : null;
  if (!job) throw new AppError('Job not found.', 404);
  await guests.apply(job, req.body || {}, req.ip);
  return created(res, null, 'Almost done: open the link we emailed you to send your application.');
});
// GET /api/jobs/guest/track?token= (public: the token is the key)
const track = asyncHandler(async (req, res) => ok(res, await guests.track(req.query.token)));
const withdraw = asyncHandler(async (req, res) => ok(res, await guests.withdraw(req.body?.token, req.body?.reason), 'Application withdrawn.'));
const confirmJoining = asyncHandler(async (req, res) => ok(res, await guests.confirmJoining(req.body?.token), 'Thank you. Your joining is confirmed.'));

// Hiring side
const list = asyncHandler(async (req, res) => ok(res, await guests.forManager(req.user, req.params.id)));
const status = asyncHandler(async (req, res) => {
  const a = await guests.updateStatus(req.user, req.params.appId, req.body || {});
  return ok(res, a, `Application moved to ${guests.STAGE_LABEL[a.status]}.`);
});
const cv = asyncHandler(async (req, res) => {
  const file = await guests.cvFile(req.user, req.params.appId);
  if (!file) throw new AppError('CV not found.', 404);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(file.data);
});

module.exports = { apply, track, withdraw, confirmJoining, list, status, cv };
