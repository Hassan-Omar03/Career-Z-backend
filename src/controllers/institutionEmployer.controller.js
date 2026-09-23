const InstitutionEmployerPartnership = require('../models/InstitutionEmployerPartnership');
const PlacementReferral = require('../models/PlacementReferral');
const Institution = require('../models/Institution');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

function assertOwnerOrStaff(institution, userId) {
  if (institution.owner.toString() === userId.toString()) return true;
  return institution.staff.some((s) => s.user.toString() === userId.toString());
}

// POST /api/institution-employer/partnerships — either side can request one.
const requestPartnership = asyncHandler(async (req, res) => {
  const { institutionId, employerEmail, message } = req.body;
  if (!institutionId || !employerEmail) throw new AppError('institutionId and employerEmail are required.', 422);

  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);

  const employer = await User.findOne({ email: employerEmail.toLowerCase().trim() });
  if (!employer || !employer.roles.includes('employer')) throw new AppError('No employer account found with that email.', 404);

  const isInstitutionSide = assertOwnerOrStaff(institution, req.user._id);
  const isEmployerSide = employer._id.toString() === req.user._id.toString();
  if (!isInstitutionSide && !isEmployerSide) throw new AppError('You must be part of the institution or be the employer to request this.', 403);

  const existing = await InstitutionEmployerPartnership.findOne({ institution: institutionId, employer: employer._id, status: { $in: ['requested', 'active'] } });
  if (existing) throw new AppError('A partnership request already exists between these two.', 409);

  const partnership = await InstitutionEmployerPartnership.create({ institution: institutionId, employer: employer._id, requestedBy: req.user._id, message: message || '' });

  const notifyTarget = isInstitutionSide ? employer._id : institution.owner;
  await notify(notifyTarget, { title: `Partnership request: ${institution.name}`, body: message || '', sentBy: req.user._id }).catch(() => {});
  return created(res, partnership, 'Partnership request sent.');
});

// PATCH /api/institution-employer/partnerships/:id/respond — whichever side did NOT request it responds.
const respondPartnership = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['active', 'declined'].includes(decision)) throw new AppError('decision must be active or declined.', 422);

  const partnership = await InstitutionEmployerPartnership.findById(req.params.id);
  if (!partnership) throw new AppError('Partnership request not found.', 404);
  if (partnership.status !== 'requested') throw new AppError('This request has already been responded to.', 400);

  const institution = await Institution.findById(partnership.institution);
  const isInstitutionSide = institution && assertOwnerOrStaff(institution, req.user._id);
  const isEmployerSide = partnership.employer.toString() === req.user._id.toString();
  const requesterIsInstitution = institution && institution.owner.toString() === partnership.requestedBy.toString();
  // Only the side that did NOT request it may respond.
  const canRespond = requesterIsInstitution ? isEmployerSide : isInstitutionSide;
  if (!canRespond) throw new AppError('Only the other party can respond to this request.', 403);

  partnership.status = decision;
  partnership.respondedAt = new Date();
  await partnership.save();

  const notifyTarget = requesterIsInstitution ? institution.owner : partnership.employer;
  await notify(notifyTarget, { title: `Partnership ${decision}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, partnership, `Partnership ${decision}.`);
});

// GET /api/institution-employer/partnerships/mine — either side.
const myPartnerships = asyncHandler(async (req, res) => {
  const myInstitutions = await Institution.find({ $or: [{ owner: req.user._id }, { 'staff.user': req.user._id }] }).select('_id');
  const partnerships = await InstitutionEmployerPartnership.find({
    $or: [{ employer: req.user._id }, { institution: { $in: myInstitutions.map((i) => i._id) } }]
  }).populate('institution', 'name logo').populate('employer', 'fullName companyName email').sort({ createdAt: -1 });
  return ok(res, partnerships);
});

// POST /api/institution-employer/referrals — institution recommends a real student for a real
// job at a partnered employer. Never auto-applies — the student still applies themselves.
const createReferral = asyncHandler(async (req, res) => {
  const { studentId, jobId } = req.body;
  if (!studentId || !jobId) throw new AppError('studentId and jobId are required.', 422);

  const job = await Job.findById(jobId);
  if (!job) throw new AppError('Job not found.', 404);

  const StudentProfile = require('../models/StudentProfile');
  const profile = await StudentProfile.findOne({ user: studentId });
  if (!profile || !profile.primaryInstitution) throw new AppError('This student is not enrolled at an institution.', 422);
  const institution = await Institution.findById(profile.primaryInstitution);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (!assertOwnerOrStaff(institution, req.user._id)) throw new AppError('Only that student\'s own institution can refer them.', 403);

  const partnership = await InstitutionEmployerPartnership.findOne({ institution: institution._id, employer: job.postedBy, status: 'active' });
  if (!partnership) throw new AppError('This institution has no active partnership with that job\'s employer.', 403);

  const referral = await PlacementReferral.create({ institution: institution._id, student: studentId, job: jobId, referredBy: req.user._id });
  await notify(studentId, { title: `You've been referred: ${job.title}`, body: `${institution.name} recommended you for this role.`, sentBy: req.user._id }).catch(() => {});
  return created(res, referral, 'Referral created.');
});

// GET /api/institution-employer/referrals/mine — student's own referrals.
const myReferrals = asyncHandler(async (req, res) => {
  const referrals = await PlacementReferral.find({ student: req.user._id }).populate('job', 'title company').populate('institution', 'name').sort({ createdAt: -1 });
  return ok(res, referrals);
});

// POST /api/institution-employer/referrals/:id/apply — the student applies via this referral;
// creates a real JobApplication (student's own consent/action), linked for placement tracking.
const applyViaReferral = asyncHandler(async (req, res) => {
  const referral = await PlacementReferral.findById(req.params.id).populate('job');
  if (!referral) throw new AppError('Referral not found.', 404);
  if (referral.student.toString() !== req.user._id.toString()) throw new AppError('This referral is not yours.', 403);
  if (referral.status !== 'referred') throw new AppError('This referral has already been actioned.', 400);

  const existingApp = await JobApplication.findOne({ job: referral.job._id, applicant: req.user._id });
  const application = existingApp || await JobApplication.create({ job: referral.job._id, applicant: req.user._id });

  referral.status = 'applied';
  referral.application = application._id;
  referral.studentRespondedAt = new Date();
  await referral.save();

  await notify(referral.referredBy, { title: `Referral applied: ${referral.job.title}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, referral, 'Applied.');
});

// GET /api/institution-employer/referrals/institution/:id — the institution's placement-office
// dashboard: every referral and its real outcome (via the linked JobApplication's status).
const institutionReferrals = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (!assertOwnerOrStaff(institution, req.user._id)) throw new AppError('You do not have access to this institution\'s placement records.', 403);

  const referrals = await PlacementReferral.find({ institution: institution._id })
    .populate('student', 'fullName email')
    .populate('job', 'title company')
    .populate('application', 'status')
    .sort({ createdAt: -1 });

  // Real outcome sync — if the linked application was actually marked hired, reflect it here
  // (computed on read, no duplicated status to drift).
  const withRealStatus = referrals.map((r) => {
    const obj = r.toObject();
    if (obj.application?.status === 'hired') obj.status = 'hired';
    return obj;
  });

  const placedCount = withRealStatus.filter((r) => r.status === 'hired').length;
  return ok(res, { referrals: withRealStatus, stats: { total: withRealStatus.length, applied: withRealStatus.filter((r) => r.status !== 'referred').length, placed: placedCount } });
});

module.exports = {
  requestPartnership, respondPartnership, myPartnerships,
  createReferral, myReferrals, applyViaReferral, institutionReferrals
};
