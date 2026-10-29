const Employment = require('../models/Employment');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

// GET /api/employment/mine — the candidate's own employment offers + history.
const myEmployments = asyncHandler(async (req, res) => {
  const employments = await Employment.find({ employee: req.user._id })
    .populate('job', 'title company companyLogo city country type')
    .populate('employer', 'fullName')
    .sort({ createdAt: -1 });
  // On an agent's job the candidate sees the offer and letter only once the agent forwards them.
  const { candidateView } = require('../services/jobOffer.service');
  return ok(res, employments.map((e) => candidateView(e.toObject())).filter(Boolean));
});

// GET /api/employment/posted — the employer's own records across all their job postings.
const postedEmployments = asyncHandler(async (req, res) => {
  const employer = req.query.employer || req.user._id;
  if (req.query.employer) await require('../services/employerStaff.service').assertPermission(req.user._id, employer, 'manage_employees');
  const employments = await Employment.find({ employer })
    .populate('job', 'title company')
    .populate('employee', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, employments);
});

// PATCH /api/employment/:id/respond — candidate accepts (with a start date) or declines.
const respondToOffer = asyncHandler(async (req, res) => {
  const { decision, startDate } = req.body;
  if (!['accepted', 'declined'].includes(decision)) throw new AppError('decision must be accepted or declined.', 422);

  const employment = await Employment.findById(req.params.id).populate('job', 'title');
  if (!employment) throw new AppError('Employment offer not found.', 404);
  if (employment.employee.toString() !== req.user._id.toString()) throw new AppError('This offer is not yours to respond to.', 403);
  if (employment.status !== 'offered') throw new AppError('This offer has already been responded to.', 400);
  if (decision === 'accepted') {
    const signedName = String(req.body.signedName || '').trim().replace(/\s+/g, ' ');
    if (signedName.length < 3) throw new AppError('Type your full name to sign and accept the offer.', 422);
    employment.signature = { name: signedName.slice(0, 120), at: new Date(), ip: String(req.ip || '').slice(0, 64), userAgent: String(req.get('user-agent') || '').slice(0, 200) };
  }
  // An offer made at the Offer stage: accepting moves the application to "Offer accepted";
  // joining comes later (Employment becomes active when the candidate is marked as joined).
  if (employment.offer?.sentAt) return ok(res, await require('../services/jobOffer.service').answerOffer(employment, req.user, decision), `Offer ${decision}.`);

  employment.respondedAt = new Date();
  if (decision === 'accepted') {
    employment.status = 'active';
    employment.startDate = startDate ? new Date(startDate) : new Date();
  } else {
    employment.status = 'declined';
  }
  await employment.save();

  await notify(employment.employer, {
    title: `Offer ${decision}: ${req.user.fullName} — ${employment.job?.title || ''}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, employment, `Offer ${decision}.`);
});

// POST /api/employment/:id/resign — employee-initiated departure.
const resign = asyncHandler(async (req, res) => {
  const employment = await Employment.findById(req.params.id).populate('job', 'title');
  if (!employment) throw new AppError('Employment record not found.', 404);
  if (employment.employee.toString() !== req.user._id.toString()) throw new AppError('This is not your employment record.', 403);
  if (employment.status !== 'active') throw new AppError('This employment is not currently active.', 400);

  employment.status = 'resigned';
  employment.endedAt = new Date();
  employment.endReason = req.body.reason || '';
  await employment.save();

  await notify(employment.employer, { title: `${req.user.fullName} resigned — ${employment.job?.title || ''}`, body: employment.endReason, sentBy: req.user._id }).catch(() => {});
  return ok(res, employment, 'Resignation recorded.');
});

// PATCH /api/employment/:id/terminate — employer-initiated departure.
const terminate = asyncHandler(async (req, res) => {
  const employment = await Employment.findById(req.params.id).populate('job', 'title');
  if (!employment) throw new AppError('Employment record not found.', 404);
  if (employment.employer.toString() !== req.user._id.toString() && !(await require('../services/employerStaff.service').hasPermission(req.user._id, employment.employer, ['manage_employees']))) throw new AppError('This is not your employment record.', 403);
  if (employment.status !== 'active') throw new AppError('This employment is not currently active.', 400);

  employment.status = 'terminated';
  employment.endedAt = new Date();
  employment.endReason = req.body.reason || '';
  await employment.save();

  await notify(employment.employee, { title: `Employment ended — ${employment.job?.title || ''}`, body: employment.endReason, sentBy: req.user._id }).catch(() => {});
  return ok(res, employment, 'Employment ended.');
});

module.exports = { myEmployments, postedEmployments, respondToOffer, resign, terminate };
