const Scholarship = require('../models/Scholarship');
const ScholarshipApplication = require('../models/ScholarshipApplication');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { isRoleVerified } = require('../utils/roleVerification');

function assertOwnsScholarship(scholarship, userId) {
  if (scholarship.donor.toString() !== userId.toString()) {
    throw new AppError('You did not create this scholarship.', 403);
  }
}

// POST /api/scholarships
const createScholarship = asyncHandler(async (req, res) => {
  if (!(await isRoleVerified(req.user._id, 'donor'))) {
    throw new AppError('Your Donor account is pending Super Admin verification. You can browse the dashboard but cannot post a scholarship until it is approved.', 403);
  }

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || body.amount === undefined) {
    throw new AppError('title and amount are required.', 422);
  }

  const scholarship = await Scholarship.create({ ...body, donor: req.user._id });
  return created(res, scholarship, 'Scholarship posted.');
});

// GET /api/scholarships (public browse)
const listScholarships = asyncHandler(async (req, res) => {
  const { country } = req.query;
  const filter = { status: 'open' };
  if (country) filter.country = country;
  const scholarships = await Scholarship.find(filter).populate('donor', 'fullName email').sort({ createdAt: -1 }).limit(100);
  return ok(res, scholarships);
});

// GET /api/scholarships/:id
const getScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id).populate('donor', 'fullName email');
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  return ok(res, scholarship);
});

// GET /api/scholarships/mine/list
const myScholarships = asyncHandler(async (req, res) => {
  const scholarships = await Scholarship.find({ donor: req.user._id }).sort({ createdAt: -1 });
  return ok(res, scholarships);
});

// PATCH /api/scholarships/:id
const updateScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  assertOwnsScholarship(scholarship, req.user._id);

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable', 'status'
  ];
  allowed.forEach((f) => { if (req.body[f] !== undefined) scholarship[f] = req.body[f]; });
  await scholarship.save();
  return ok(res, scholarship);
});

// POST /api/scholarships/:id/apply
const applyToScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  if (scholarship.status !== 'open') throw new AppError('This scholarship is closed.', 400);

  const existing = await ScholarshipApplication.findOne({ scholarship: scholarship._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this scholarship.', 409);

  const application = await ScholarshipApplication.create({
    scholarship: scholarship._id,
    applicant: req.user._id,
    statement: req.body.statement || ''
  });

  return created(res, application, 'Application submitted.');
});

// GET /api/scholarships/mine/applications (as applicant)
const myApplications = asyncHandler(async (req, res) => {
  const applications = await ScholarshipApplication.find({ applicant: req.user._id })
    .populate('scholarship', 'title amount currency status')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// GET /api/scholarships/:id/applicants
const listApplicants = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  assertOwnsScholarship(scholarship, req.user._id);

  const applications = await ScholarshipApplication.find({ scholarship: scholarship._id })
    .populate('applicant', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// PATCH /api/scholarships/applications/:appId/status
const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const application = await ScholarshipApplication.findById(req.params.appId).populate('scholarship');
  if (!application) throw new AppError('Application not found.', 404);
  assertOwnsScholarship(application.scholarship, req.user._id);

  application.status = status;
  application.reviewedAt = new Date();
  await application.save();
  return ok(res, application, `Application ${status}.`);
});

// GET /api/scholarships/admin/all (admin oversight — every status, any donor)
const adminListAll = asyncHandler(async (req, res) => {
  const scholarships = await Scholarship.find({}).populate('donor', 'fullName email').sort({ createdAt: -1 });
  return ok(res, scholarships);
});

module.exports = {
  createScholarship,
  adminListAll,
  listScholarships,
  getScholarship,
  myScholarships,
  updateScholarship,
  applyToScholarship,
  myApplications,
  listApplicants,
  updateApplicationStatus
};
