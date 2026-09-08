const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const Resume = require('../models/Resume');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function assertOwnsJob(job, userId) {
  if (job.postedBy.toString() !== userId.toString()) {
    throw new AppError('You did not post this job.', 403);
  }
}

// POST /api/jobs
const createJob = asyncHandler(async (req, res) => {
  const allowed = [
    'title', 'company', 'type', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
    'experienceYears', 'education', 'skills', 'description', 'applicationDeadline',
    'visaSponsorship', 'companyLogo', 'contactEmail', 'contactPhone', 'isGovernment'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || !body.company || !body.country) {
    throw new AppError('title, company and country are required.', 422);
  }

  const job = await Job.create({ ...body, postedBy: req.user._id });
  return created(res, job, 'Job posted.');
});

// GET /api/jobs (public search)
const listJobs = asyncHandler(async (req, res) => {
  const { q, country, city, type, minSalary } = req.query;
  const filter = { status: 'open' };
  if (country) filter.country = country;
  if (city) filter.city = new RegExp(city, 'i');
  if (type) filter.type = type;
  if (minSalary) filter.salaryMin = { $gte: Number(minSalary) };
  if (q) filter.$text = { $search: q };

  const jobs = await Job.find(filter).populate('postedBy', 'fullName email').sort({ createdAt: -1 }).limit(100);
  return ok(res, jobs);
});

// GET /api/jobs/:id
const getJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id).populate('postedBy', 'fullName email');
  if (!job) throw new AppError('Job not found.', 404);
  return ok(res, job);
});

// GET /api/jobs/mine/list
const myJobs = asyncHandler(async (req, res) => {
  const jobs = await Job.find({ postedBy: req.user._id }).sort({ createdAt: -1 });
  return ok(res, jobs);
});

// PATCH /api/jobs/:id
const updateJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  assertOwnsJob(job, req.user._id);

  const allowed = [
    'title', 'company', 'type', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
    'experienceYears', 'education', 'skills', 'description', 'applicationDeadline',
    'visaSponsorship', 'companyLogo', 'contactEmail', 'contactPhone', 'status'
  ];
  allowed.forEach((f) => { if (req.body[f] !== undefined) job[f] = req.body[f]; });
  await job.save();
  return ok(res, job);
});

// POST /api/jobs/:id/apply
const applyToJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  if (job.status !== 'open') throw new AppError('This job is no longer accepting applications.', 400);

  const existing = await JobApplication.findOne({ job: job._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this job.', 409);

  const resume = await Resume.findOne({ user: req.user._id });

  const application = await JobApplication.create({
    job: job._id,
    applicant: req.user._id,
    coverLetter: req.body.coverLetter || '',
    resumeSnapshot: resume ? resume.toObject() : null
  });

  return created(res, application, 'Application submitted.');
});

// GET /api/jobs/mine/applications (as applicant)
const myApplications = asyncHandler(async (req, res) => {
  const applications = await JobApplication.find({ applicant: req.user._id })
    .populate('job', 'title company city country type status')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// GET /api/jobs/:id/applicants
const listApplicants = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  assertOwnsJob(job, req.user._id);

  const applications = await JobApplication.find({ job: job._id })
    .populate('applicant', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// PATCH /api/jobs/applications/:appId/status
const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'shortlisted', 'interview', 'rejected', 'hired'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  assertOwnsJob(application.job, req.user._id);

  application.status = status;
  await application.save();
  return ok(res, application, `Application ${status}.`);
});

module.exports = {
  createJob,
  listJobs,
  getJob,
  myJobs,
  updateJob,
  applyToJob,
  myApplications,
  listApplicants,
  updateApplicationStatus
};
