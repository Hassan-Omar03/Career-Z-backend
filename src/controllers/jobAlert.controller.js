const JobAlert = require('../models/JobAlert');
const Job = require('../models/Job');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function buildJobFilter(alert) {
  const filter = { status: 'active' };
  if (alert.country) filter.country = alert.country;
  if (alert.city) filter.city = new RegExp(alert.city, 'i');
  if (alert.remoteOnly) filter.workMode = { $in: ['remote', 'hybrid'] };
  if (alert.salaryMin) filter.salaryMin = { $gte: alert.salaryMin };
  if (alert.governmentOnly) filter.isGovernment = true;
  if (alert.internationalOnly) filter.visaSponsorship = true;
  if (alert.keywords) filter.$text = { $search: alert.keywords };
  return filter;
}

// POST /api/job-alerts
const createAlert = asyncHandler(async (req, res) => {
  const { keywords, country, city, remoteOnly, salaryMin, governmentOnly, internationalOnly } = req.body;
  const alert = await JobAlert.create({
    user: req.user._id,
    keywords: keywords || '',
    country: country || '',
    city: city || '',
    remoteOnly: !!remoteOnly,
    salaryMin: salaryMin || null,
    governmentOnly: !!governmentOnly,
    internationalOnly: !!internationalOnly
  });
  return created(res, alert, 'Job alert saved.');
});

// GET /api/job-alerts/mine — each alert plus how many currently-open jobs match it right now.
const myAlerts = asyncHandler(async (req, res) => {
  const alerts = await JobAlert.find({ user: req.user._id }).sort({ createdAt: -1 });
  const withCounts = await Promise.all(alerts.map(async (a) => {
    const matchCount = await Job.countDocuments(buildJobFilter(a));
    return { ...a.toObject(), matchCount };
  }));
  return ok(res, withCounts);
});

// DELETE /api/job-alerts/:id
const deleteAlert = asyncHandler(async (req, res) => {
  const alert = await JobAlert.findById(req.params.id);
  if (!alert) throw new AppError('Alert not found.', 404);
  if (alert.user.toString() !== req.user._id.toString()) throw new AppError('You do not own this alert.', 403);
  await alert.deleteOne();
  return ok(res, null, 'Alert removed.');
});

module.exports = { createAlert, myAlerts, deleteAlert };
