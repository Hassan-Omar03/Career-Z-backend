const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const Resume = require('../models/Resume');
const User = require('../models/User');
const Interview = require('../models/Interview');
const Notification = require('../models/Notification');
const Commission = require('../models/Commission');
const Withdrawal = require('../models/Withdrawal');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');
const { PAYMENT_METHOD_LABEL } = require('../utils/paymentMethods');

const jobAccess = require('../services/jobAccess.service');
const publishing = require('../services/jobPublishing.service');
const { JOB_CATEGORIES } = require('../models/Job');

// The poster, or the owner / recruitment staff of the job's institute (see jobAccess.service).
async function assertOwnsJob(job, userOrId, perm) {
  const user = userOrId?._id ? userOrId : { _id: userOrId };
  await jobAccess.assertCanManageJob(job, user, perm);
}

// Fields that change what applicants read; editing them on a live job re-runs the risk scan.
const CONTENT_FIELDS = ['title', 'company', 'description', 'salaryMin', 'salaryMax', 'visaSponsorship', 'contactEmail', 'contactPhone', 'skills'];

// POST /api/jobs
// Vacancies, gender and age range (optional) and saved interview questions on a job post.
function checkPostingExtras(body) {
  const blankToNull = (k) => { if (body[k] === '' ) body[k] = null; };
  ['ageMin', 'ageMax'].forEach(blankToNull);
  if (body.vacancies !== undefined) {
    const v = Number(body.vacancies);
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw new AppError('Vacancies must be a whole number from 1 to 1000.', 422);
    body.vacancies = v;
  }
  if (body.genderPreference !== undefined && !['any', 'male', 'female'].includes(body.genderPreference)) throw new AppError('Choose any, male or female.', 422);
  for (const k of ['ageMin', 'ageMax']) {
    if (body[k] === undefined || body[k] === null) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 14 || n > 80) throw new AppError('Age must be a whole number from 14 to 80.', 422);
    body[k] = n;
  }
  if (body.ageMin != null && body.ageMax != null && body.ageMin > body.ageMax) throw new AppError('Minimum age cannot be more than maximum age.', 422);
  if (body.interviewQuestions !== undefined) body.interviewQuestions = [].concat(body.interviewQuestions || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 20).map((q) => q.slice(0, 300));
}

const createJob = asyncHandler(async (req, res) => {
  const publisher = await jobAccess.publisherFor(req.user, req.body.institution, req.body.agreement, req.body.employer);
  if (publisher.role === 'education_agent') await require('../services/agentWork.service').assertMayPost(req.user);

  const allowed = [
    'title', 'company', 'type', 'workMode', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
    'experienceYears', 'education', 'skills', 'description', 'applicationDeadline',
    'visaSponsorship', 'companyLogo', 'contactEmail', 'contactPhone', 'isGovernment', 'status', 'category',
    'vacancies', 'genderPreference', 'ageMin', 'ageMax', 'interviewQuestions'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  checkPostingExtras(body);
  if (!body.title || !body.company || !body.country) {
    throw new AppError('title, company and country are required.', 422);
  }
  if (body.status && !['draft', 'active'].includes(body.status)) {
    throw new AppError('A new job can only be created as draft or active.', 422);
  }

  if (body.category && !JOB_CATEGORIES.includes(body.category)) throw new AppError('Choose a valid job category.', 422);
  // An institute's job always carries the institute's own name and logo.
  if (publisher.institution) { body.company = publisher.institution.name; if (!body.companyLogo && publisher.institution.logo) body.companyLogo = publisher.institution.logo; }
  const wantsPublish = (body.status || 'active') === 'active';
  if (wantsPublish && publisher.role === 'employer') await require('../services/employerPackages.service').assertMayGoLive(publisher.postedBy || req.user._id);
  const job = await Job.create({ ...body, status: 'draft', postedBy: publisher.postedBy || req.user._id, institution: publisher.institution?._id || null,
    agreement: publisher.agreement?._id || null, recruitmentRequest: publisher.agreement?.request || null });
  if (publisher.role === 'education_agent' && !publisher.agreement && req.body.employerEmail) {
    try { await require('../services/agentWork.service').linkEmployer(job, req.user, req.body.employerEmail); } catch (e) { await Job.deleteOne({ _id: job._id }); throw e; }
  }
  const outcome = wantsPublish ? await publishing.submit(job, req.user, publisher.role === 'institution_staff' ? null : publisher.role) : { published: false, flags: [] };
  if (outcome.published) require('./placement.controller').tellPartnersOfNewJob(await Job.findById(job._id).lean()).catch(() => {});
  if (outcome.published) require('../services/plugins.service').emit('job.published', { jobId: job._id, title: job.title, company: job.company, country: job.country, city: job.city, type: job.type || '' });
  return created(res, { ...job.toObject(), outcome }, !wantsPublish ? 'Job saved as draft.' : outcome.published ? 'Job published.' : 'Job sent to admin review before it goes live.');

});

// GET /api/jobs (public search)
const listJobs = asyncHandler(async (req, res) => {
  const { q, country, city, type, minSalary } = req.query;
  const filter = { status: 'active' };
  if (country) filter.country = country;
  // Searched as plain text: characters typed in the box must not change the query.
  if (city) filter.city = new RegExp(String(city).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (type) filter.type = type;
  if (minSalary) filter.salaryMin = { $gte: Number(minSalary) };
  if (q) filter.$text = { $search: q };

  // A featured badge that outlived its paid window shouldn't keep jumping the queue.
  await Job.updateMany({ featured: true, featuredUntil: { $lt: new Date() } }, { featured: false, featuredUntil: null });

  const jobs = await Job.find(filter).populate('postedBy', 'fullName').sort({ featured: -1, sponsored: -1, createdAt: -1 }).limit(100);
  return ok(res, jobs);
});

// GET /api/jobs/:id
const getJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id).populate('postedBy', 'fullName');
  if (!job) throw new AppError('Job not found.', 404);
  // Drafts, held and rejected jobs are visible only to the people who manage them.
  if (!['active', 'paused', 'closed', 'filled'].includes(job.status) && !(req.user && (await jobAccess.canManageJob(job, req.user)))) {
    throw new AppError('Job not found.', 404);
  }

  if (!req.user || String(req.user._id) !== String(job.postedBy?._id || job.postedBy)) Job.updateOne({ _id: job._id }, { $inc: { views: 1 } }).catch(() => {});
  // "Recently viewed jobs" — only for a signed-in viewer actually opening the job's own
  // detail view, not every list/search hit. Dedupe (most-recent-first), cap at 20.
  if (req.user) {
    await User.updateOne({ _id: req.user._id }, { $pull: { recentlyViewedJobs: { job: job._id } } });
    await User.updateOne(
      { _id: req.user._id },
      { $push: { recentlyViewedJobs: { $each: [{ job: job._id, viewedAt: new Date() }], $position: 0, $slice: 20 } } }
    );
  }

  return ok(res, job);
});

// GET /api/jobs/mine/list
const myJobs = asyncHandler(async (req, res) => {
  const institutions = await jobAccess.manageableInstitutionIds(req.user);
  const wanted = req.query.institution;
  let filter;
  if (req.query.employer) {
    if (!(await require('../services/employerStaff.service').hasPermission(req.user._id, req.query.employer, ['post_jobs', 'manage_applicants']))) throw new AppError('You do not have hiring permission for this company.', 403);
    filter = { postedBy: req.query.employer, institution: null, agreement: null };
  } else if (wanted) {
    if (!institutions.some((id) => String(id) === String(wanted))) throw new AppError('You cannot manage this institute\'s jobs.', 403);
    filter = { institution: wanted, agreement: null };
  } else filter = { $or: [{ postedBy: req.user._id }, ...(institutions.length ? [{ institution: { $in: institutions }, agreement: null }] : [])] };
  const jobs = await Job.find(filter).select('+interviewQuestions').sort({ createdAt: -1 });
  const counts = await JobApplication.aggregate([
    { $match: { job: { $in: jobs.map((j) => j._id) } } },
    { $group: { _id: '$job', count: { $sum: 1 } } }
  ]);
  const countByJob = Object.fromEntries(counts.map((c) => [c._id.toString(), c.count]));
  // Guests who confirmed their email are applicants too.
  const guestCounts = await require('../models/GuestApplication').aggregate([{ $match: { job: { $in: jobs.map((j) => j._id) }, emailVerified: true } }, { $group: { _id: '$job', count: { $sum: 1 } } }]);
  for (const g of guestCounts) countByJob[g._id.toString()] = (countByJob[g._id.toString()] || 0) + g.count;
  const guestByJob = Object.fromEntries(guestCounts.map((g) => [g._id.toString(), g.count]));
  const withCounts = jobs.map((j) => ({ ...j.toObject(), applicantCount: countByJob[j._id.toString()] || 0, guestApplicantCount: guestByJob[j._id.toString()] || 0 }));
  return ok(res, withCounts);
});

// GET /api/jobs/mine/summary — Employer/Agent dashboard summary cards, all real aggregates.
// Also runs the "Interview reminder" / "Job expiry reminder" lazy checks (no cron in this app)
// since this endpoint is guaranteed to load every time the dashboard opens.
const myJobsSummary = asyncHandler(async (req, res) => {
  const owner = req.actingFor || req.user._id;
  const jobs = await Job.find({ postedBy: owner }).select('_id status title applicationDeadline');
  const jobIds = jobs.map((j) => j._id);
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const [appCounts, scheduledInterviewsCount, reminderInterviews] = await Promise.all([
    JobApplication.aggregate([
      { $match: { job: { $in: jobIds } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Interview.countDocuments({ $or: [{ scheduledBy: req.user._id }, { job: { $in: jobIds } }], status: 'scheduled', scheduledDate: { $gte: now } }),
    Interview.find({ $or: [{ scheduledBy: req.user._id }, { job: { $in: jobIds } }], status: 'scheduled', scheduledDate: { $gte: now, $lte: in48h } })
      .populate('candidate', 'fullName')
  ]);
  const countByStatus = Object.fromEntries(appCounts.map((c) => [c._id, c.count]));

  await Promise.all(reminderInterviews.map(async (i) => {
    const title = `Interview reminder: ${i.candidate?.fullName || 'a candidate'} — ${new Date(i.scheduledDate).toLocaleString()}`;
    const already = await Notification.findOne({ user: req.user._id, title });
    if (!already) await notify(req.user._id, { title, sentBy: null }).catch(() => {});
  }));

  await Promise.all(jobs.filter((j) => j.status === 'active' && j.applicationDeadline && new Date(j.applicationDeadline) > now && new Date(j.applicationDeadline) <= in3Days).map(async (j) => {
    const title = `Job expiry reminder: ${j.title}`;
    const already = await Notification.findOne({ user: req.user._id, title });
    if (!already) await notify(req.user._id, { title, body: `Application deadline: ${new Date(j.applicationDeadline).toLocaleDateString()}`, sentBy: null }).catch(() => {});
  }));

  return ok(res, {
    activeJobPosts: jobs.filter((j) => j.status === 'active').length,
    totalApplicants: appCounts.reduce((sum, c) => sum + c.count, 0),
    shortlistedCandidates: countByStatus.shortlisted || 0,
    scheduledInterviews: scheduledInterviewsCount,
    successfulHires: countByStatus.hired || 0
  });
});

// GET /api/jobs/mine/recent-activity — Employer/Agent dashboard feed, all 7 event types built
// from real records (Job/JobApplication/Interview/Commission/Withdrawal), not fabricated.
const myRecentActivity = asyncHandler(async (req, res) => {
  const owner = req.actingFor || req.user._id;
  const jobs = await Job.find({ postedBy: owner }).select('_id title createdAt');
  const jobIds = jobs.map((j) => j._id);

  const [applications, interviews, commissions, withdrawals] = await Promise.all([
    JobApplication.find({ job: { $in: jobIds } }).populate('applicant', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(20),
    Interview.find({ $or: [{ scheduledBy: req.user._id }, { job: { $in: jobIds } }] }).populate('candidate', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(10),
    Commission.find({ agent: owner }).populate('candidate', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(10),
    Withdrawal.find({ agent: req.user._id }).sort({ createdAt: -1 }).limit(10)
  ]);

  const activity = [
    ...jobs.map((j) => ({ id: `job-${j._id}`, title: `Job posted: ${j.title}`, time: j.createdAt })),
    ...applications.map((a) => ({ id: `app-${a._id}`, title: `Application received: ${a.applicant?.fullName || 'a candidate'} — ${a.job?.title || ''}`, time: a.createdAt })),
    ...applications.filter((a) => a.status === 'shortlisted').map((a) => ({ id: `short-${a._id}`, title: `Candidate shortlisted: ${a.applicant?.fullName || 'a candidate'} — ${a.job?.title || ''}`, time: a.updatedAt })),
    ...interviews.map((i) => ({ id: `iv-${i._id}`, title: `Interview scheduled: ${i.candidate?.fullName || 'a candidate'} — ${i.job?.title || ''}`, time: i.createdAt })),
    ...applications.filter((a) => a.status === 'hired').map((a) => ({ id: `hire-${a._id}`, title: `Candidate hired: ${a.applicant?.fullName || 'a candidate'} — ${a.job?.title || ''}`, time: a.updatedAt })),
    ...commissions.map((c) => ({ id: `comm-${c._id}`, title: `Commission earned: ${c.currency} ${c.amount} — ${c.job?.title || ''}`, time: c.createdAt })),
    ...withdrawals.map((w) => ({ id: `wd-${w._id}`, title: `Withdrawal requested: ${w.currency} ${w.amount}`, time: w.createdAt }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

  return ok(res, activity);
});

// PATCH /api/jobs/:id
const updateJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  await assertOwnsJob(job, req.user, 'post_jobs');
  if (job.status === 'removed_by_admin') throw new AppError(`CareerZ admin removed this: ${job.adminRemoval?.reason || 'it broke the rules'}. Contact support if you think this is wrong.`, 403);
  if (req.body.status === 'active' && !job.institution && !job.agreement) {
    await require('../services/employerTrust.service').assertEmployerMayPost(job.postedBy);
    if (job.status !== 'active') await require('../services/employerPackages.service').assertMayGoLive(job.postedBy, job._id);
  }

  const allowed = [
    'title', 'company', 'type', 'workMode', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
    'experienceYears', 'education', 'skills', 'description', 'applicationDeadline',
    'visaSponsorship', 'companyLogo', 'contactEmail', 'contactPhone', 'category',
    'vacancies', 'genderPreference', 'ageMin', 'ageMax', 'interviewQuestions'
  ];
  checkPostingExtras(req.body);
  if (req.body.category !== undefined && !JOB_CATEGORIES.includes(req.body.category)) throw new AppError('Choose a valid job category.', 422);
  const contentChanged = CONTENT_FIELDS.some((f) => req.body[f] !== undefined && JSON.stringify(req.body[f]) !== JSON.stringify(job[f]));
  allowed.forEach((f) => { if (req.body[f] !== undefined) job[f] = req.body[f]; });
  if (job.institution && req.body.company !== undefined) { const inst = await require('../models/Institution').findById(job.institution).select('name'); if (inst) job.company = inst.name; }

  // Status the publisher may ask for. Going live always passes through the risk scan; an admin
  // decides held jobs, so 'pending_review' and 'rejected' cannot be set or skipped here.
  const wanted = req.body.status;
  if (wanted !== undefined && !['draft', 'active', 'paused', 'closed', 'filled'].includes(wanted)) throw new AppError('Invalid job status.', 422);
  const live = ['active', 'paused'].includes(job.status);
  let outcome = null;
  if (wanted === 'active' && !live) outcome = await publishing.submit(job, req.user, await publisherRole(job, req.user));
  else if (wanted === 'active' && job.status === 'paused') { if (contentChanged) outcome = await publishing.submit(job, req.user, await publisherRole(job, req.user)); else { job.status = 'active'; await job.save(); } }
  else if (['paused', 'closed', 'filled'].includes(wanted)) { if (!live) throw new AppError('Only a live job can be paused, closed or marked filled.', 409); job.status = wanted; await job.save(); }
  else if (wanted === 'draft') { if (live) throw new AppError('A published job cannot go back to draft; pause or close it instead.', 409); job.status = 'draft'; await job.save(); }
  else if (contentChanged && job.status === 'active') outcome = await publishing.submit(job, req.user, await publisherRole(job, req.user));
  else await job.save();
  return ok(res, { ...job.toObject(), outcome }, outcome && !outcome.published ? 'Changes sent to admin review before they go live.' : 'Job updated.');
});

// Every rule for one application, shared by single apply and Smart Apply.
async function submitApplication(req, job, coverLetter, cvChoice) {
  if (job.status !== 'active') throw new AppError('This job is no longer accepting applications.', 400);
  if (job.applicationDeadline && new Date(job.applicationDeadline) < new Date()) {
    throw new AppError('The application deadline has passed.', 400);
  }
  // Job seekers apply: an approved student or teacher account (the account gate has already
  // required approval and a complete profile for that role).
  const roles = req.accessibleRoles || req.user.roles || [];
  if (!roles.some((r) => ['student', 'teacher'].includes(r))) {
    throw new AppError('Only student or teacher accounts can apply for jobs. Sign in with one, or create a student account.', 403, { code: 'WRONG_ACCOUNT_TYPE', eligible: ['student', 'teacher'] });
  }
  // The publisher must still be allowed to list it (an approved, active employer or agent).
  if (!(await require('../services/publicListings.service').jobDetail(job._id))) throw new AppError('This job is no longer accepting applications.', 400);
  if (!req.user.emailVerified) throw new AppError('Verify your email before applying to a job (Profile tab).', 403);

  const existing = await JobApplication.findOne({ job: job._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this job.', 409);

  // The CV the applicant chose (main CV, a CV Version or the uploaded file); default as before.
  const resumeSnapshot = await require('../services/cvChoice.service').snapshotFor(req.user._id, cvChoice);

  const application = await JobApplication.create({
    job: job._id,
    applicant: req.user._id,
    coverLetter: String(coverLetter || '').slice(0, 4000),
    resumeSnapshot
  });

  application.statusHistory.push({ status: 'pending', by: req.user._id, byRole: 'applicant', note: 'Applied' });
  await application.save();
  require('../services/plugins.service').emit('job_application.created', { applicationId: application._id, jobId: job._id, jobTitle: job.title, applicantId: req.user._id, applicantName: req.user.fullName });
  const managers = new Set([String(job.postedBy)]);
  if (job.institution) { const inst = await require('../models/Institution').findById(job.institution).select('owner'); if (inst) managers.add(String(inst.owner)); }
  for (const id of managers) {
    await notify(id, { title: `New application: ${req.user.fullName} — ${job.title}`, body: job.company, sentBy: req.user._id, link: require('../utils/dashLinks').manager(job), category: 'application' },
      { email: true, emailPreference: 'applicationEmails', ctaLabel: 'Review applicants' }).catch(() => {});
  }
  // The applicant's own receipt.
  await notify(req.user._id, { title: `Application received: ${job.title} @ ${job.company}`, body: 'Track its progress in My Applications.', link: require('../utils/dashLinks').candidate('applications'), category: 'application' },
    { email: true, emailPreference: 'applicationEmails', ctaLabel: 'View job' }).catch(() => {});
  return application;
}

// The role a job was posted under, for the risk scan's verification context.
async function publisherRole(job, user) {
  if (job.agreement) return 'education_agent';
  if (job.institution) return null;
  const poster = String(job.postedBy) === String(user._id) ? user : await User.findById(job.postedBy).select('roles');
  if (poster?.roles?.includes('employer') && (await isRoleVerified(poster._id, 'employer'))) return 'employer';
  return 'education_agent';
}

// POST /api/jobs/:id/apply
const applyToJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  const application = await submitApplication(req, job, req.body.coverLetter, req.body.cv);
  return created(res, application, 'Application submitted.');
});

// ---------------------------------------------------------------- Smart Apply
// Open jobs ranked against the applicant's CV (skills, location, experience, education), so a
// student can pick several and apply to all of them at once with one cover letter. The score is
// computed from the two documents; nothing is guessed.
const SMART_APPLY_MAX = 20;
const SMART_APPLY_DAILY = 40;

function matchJob(job, resume, user) {
  const jobSkills = (job.skills || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  const mine = new Set((resume?.skills || []).map((s) => String(s).toLowerCase().trim()));
  const matched = jobSkills.filter((s) => mine.has(s));
  const reasons = [];
  let score = 0, weight = 0;
  if (jobSkills.length) { weight += 50; score += 50 * (matched.length / jobSkills.length); if (matched.length) reasons.push(`${matched.length} of ${jobSkills.length} skills: ${matched.slice(0, 4).join(', ')}`); }
  const years = EXPERIENCE_LEVEL_YEARS[resume?.experienceLevel] ?? 0;
  weight += 20;
  if (!job.experienceYears || years >= job.experienceYears) { score += 20; if (job.experienceYears) reasons.push(`Meets ${job.experienceYears}+ years experience`); }
  weight += 20;
  if (job.workMode === 'remote') { score += 20; reasons.push('Remote'); }
  else if (user.city && job.city && String(user.city).toLowerCase() === String(job.city).toLowerCase()) { score += 20; reasons.push(`In your city (${job.city})`); }
  else if (!job.country || job.country === user.country) score += 10;
  if (job.education) {
    weight += 10;
    const need = job.education.toLowerCase();
    if ((resume?.education || []).some((e) => { const d = String(e.degree || '').toLowerCase(); return d && (d.includes(need) || need.includes(d)); })) { score += 10; reasons.push(`Education: ${job.education}`); }
  }
  return { score: Math.round((score / weight) * 100), reasons, missingSkills: jobSkills.filter((s) => !mine.has(s)).slice(0, 5) };
}

// GET /api/jobs/smart-apply/matches
const smartApplyMatches = asyncHandler(async (req, res) => {
  const [resume, applied, open] = await Promise.all([
    Resume.findOne({ user: req.user._id }).lean(),
    JobApplication.distinct('job', { applicant: req.user._id }),
    require('../services/publicListings.service').listJobs({ limit: 48 })
  ]);
  const ids = open.items.map((j) => j._id).filter((id) => !applied.some((a) => String(a) === String(id)));
  const jobs = await Job.find({ _id: { $in: ids } }).select('title company city country type workMode skills experienceYears education salaryMin salaryMax currency applicationDeadline').lean();
  const ranked = jobs.map((j) => ({ ...j, match: matchJob(j, resume, req.user) })).sort((a, b) => b.match.score - a.match.score);
  const today = await JobApplication.countDocuments({ applicant: req.user._id, createdAt: { $gte: new Date(Date.now() - 864e5) } });
  return ok(res, { jobs: ranked, hasResume: Boolean(resume), resumeSkills: resume?.skills?.length || 0, perRequest: SMART_APPLY_MAX, remainingToday: Math.max(0, SMART_APPLY_DAILY - today) });
});

// POST /api/jobs/smart-apply { jobIds, coverLetter } — applies to each job under the same rules
// as a single application and reports, per job, whether it was sent or why not. {job} and
// {company} in the cover letter are filled in for each job.
const smartApply = asyncHandler(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.jobIds) ? req.body.jobIds : []).map(String))].filter((id) => require('mongoose').isValidObjectId(id));
  if (!ids.length) throw new AppError('Choose at least one job.', 422);
  if (ids.length > SMART_APPLY_MAX) throw new AppError(`Choose at most ${SMART_APPLY_MAX} jobs at a time.`, 422);
  const today = await JobApplication.countDocuments({ applicant: req.user._id, createdAt: { $gte: new Date(Date.now() - 864e5) } });
  const room = Math.max(0, SMART_APPLY_DAILY - today);
  if (!room) throw new AppError(`You have sent ${SMART_APPLY_DAILY} applications in the last 24 hours. Try again tomorrow.`, 429);
  const template = String(req.body.coverLetter || '').slice(0, 4000);
  const jobs = await Job.find({ _id: { $in: ids } });
  const results = [];
  let sent = 0;
  for (const id of ids) {
    const job = jobs.find((j) => String(j._id) === id);
    if (!job) { results.push({ job: id, status: 'skipped', reason: 'Job not found.' }); continue; }
    if (sent >= room) { results.push({ job: id, title: job.title, status: 'skipped', reason: 'Daily limit reached. Apply to this one tomorrow.' }); continue; }
    try {
      const letter = template.replace(/\{job\}/gi, job.title).replace(/\{company\}/gi, job.company);
      const application = await submitApplication(req, job, letter);
      sent += 1;
      results.push({ job: id, title: job.title, company: job.company, status: 'applied', application: application._id });
    } catch (err) {
      results.push({ job: id, title: job.title, company: job.company, status: 'skipped', reason: err.message });
    }
  }
  return ok(res, { applied: sent, skipped: results.length - sent, results }, sent ? `Applied to ${sent} job${sent === 1 ? '' : 's'}.` : 'No applications were sent.');
});

// GET /api/jobs/mine/applications (as applicant)
const myApplications = asyncHandler(async (req, res) => {
  const applications = await JobApplication.find({ applicant: req.user._id })
    .populate('job', 'title company city country type status')
    .sort({ createdAt: -1 });
  const offers = await require('../models/Employment').find({ application: { $in: applications.map((a) => a._id) } }).populate('job', 'title company companyLogo city country type').lean();
  const offerOf = new Map(offers.map((o) => [String(o.application), o]));
  const { candidateView } = require('../services/jobOffer.service');
  return ok(res, applications.map((a) => ({ ...a.toObject(), employment: candidateView(offerOf.get(String(a._id))) || null, messageCount: (a.messages || []).length, messages: undefined })));
});

// A candidate's experienceLevel is categorical, a job's experienceYears is numeric — this maps
// the category to a representative year count so the two can actually be compared.
const EXPERIENCE_LEVEL_YEARS = { entry: 1, mid: 3, senior: 7, lead: 12 };

// GET /api/jobs/:id/recommended-candidates — real, computed matching (skills/experience/
// location/qualification), not an AI call: every score is explainable from the two documents.
const listRecommendedCandidates = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  await assertOwnsJob(job, req.user);

  const existingApplicantIds = new Set(
    (await JobApplication.find({ job: job._id }).select('applicant')).map((a) => a.applicant.toString())
  );

  const resumes = await Resume.find({ skills: { $exists: true, $not: { $size: 0 } } })
    .populate('user', 'fullName profilePhoto country')
    .limit(200);

  const jobSkills = (job.skills || []).map((s) => s.toLowerCase());

  const scored = resumes.filter((r) => r.user).map((r) => {
    const candSkills = (r.skills || []).map((s) => s.toLowerCase());
    const matchedSkills = jobSkills.filter((s) => candSkills.includes(s));
    const skillsMatchPercent = jobSkills.length > 0 ? Math.round((matchedSkills.length / jobSkills.length) * 100) : 0;

    const candidateYears = EXPERIENCE_LEVEL_YEARS[r.experienceLevel] ?? 0;
    const experienceMatch = job.experienceYears ? candidateYears >= job.experienceYears : true;

    const locationMatch = job.country ? r.user.country === job.country : true;

    const qualificationMatch = job.education
      ? (r.education || []).some((ed) => {
          const degree = (ed.degree || '').toLowerCase();
          const required = job.education.toLowerCase();
          return degree.includes(required) || required.includes(degree);
        })
      : true;

    const recommended = skillsMatchPercent >= 50 && experienceMatch && locationMatch && qualificationMatch;

    return {
      candidate: { _id: r.user._id, fullName: r.user.fullName, profilePhoto: r.user.profilePhoto },
      headline: r.headline,
      skills: r.skills,
      experienceLevel: r.experienceLevel,
      location: r.location,
      education: r.education,
      cvFileUrl: r.cvFileUrl,
      alreadyApplied: existingApplicantIds.has(r.user._id.toString()),
      skillsMatchPercent,
      experienceMatch,
      locationMatch,
      qualificationMatch,
      recommended
    };
  }).sort((a, b) => b.skillsMatchPercent - a.skillsMatchPercent).slice(0, 30);

  return ok(res, scored);
});

// POST /api/jobs/:id/shortlist — Employer/Agent proactively shortlists someone from the
// candidate pool who hasn't applied yet (or updates their status if they already have).
const shortlistCandidate = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  await assertOwnsJob(job, req.user);

  const { candidateId } = req.body;
  if (!candidateId) throw new AppError('candidateId is required.', 422);

  let application = await JobApplication.findOne({ job: job._id, applicant: candidateId });
  if (application) {
    application.status = 'shortlisted';
    await application.save();
  } else {
    const resume = await Resume.findOne({ user: candidateId });
    application = await JobApplication.create({
      job: job._id,
      applicant: candidateId,
      status: 'shortlisted',
      resumeSnapshot: resume ? resume.toObject() : null
    });
  }

  await notify(candidateId, {
    title: `You've been shortlisted: ${job.title} @ ${job.company}`,
    body: 'A recruiter found your profile a strong match and shortlisted you for this role.',
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, application, 'Candidate shortlisted.');
});

// GET /api/jobs/:id/applicants
const listApplicants = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  await assertOwnsJob(job, req.user);

  const applications = await JobApplication.find({ job: job._id })
    .populate('applicant', 'fullName email phone city country profilePhoto')
    .sort({ createdAt: -1 });

  // Real "Profile Views" signal for the job-seeker dashboard — an employer opening the
  // applicant list is a genuine view of each candidate's resume, not a fabricated counter.
  const applicantIds = applications.map((a) => a.applicant._id);
  if (applicantIds.length > 0) {
    await Resume.updateMany({ user: { $in: applicantIds } }, { $inc: { viewCount: 1 } });
  }

  // A still-"pending" application genuinely becomes "viewed" the first time the employer
  // opens the applicant list — a real status transition, not a fabricated one.
  const stillPending = applications.filter((a) => a.status === 'pending');
  if (stillPending.length > 0) {
    await JobApplication.updateMany({ _id: { $in: stillPending.map((a) => a._id) } }, { status: 'viewed' });
    stillPending.forEach((a) => { a.status = 'viewed'; });
    await Promise.all(stillPending.map((a) => notify(a.applicant._id, {
      title: `${job.title} @ ${job.company}: Application viewed`,
      body: 'The employer has viewed your application.',
      sentBy: req.user._id
    }).catch(() => {})));
  }

  const offers = await require('../models/Employment').find({ application: { $in: applications.map((a) => a._id) } }).select('application status salary currency startDate offer offerLetter').lean();
  const offerOf = new Map(offers.map((o) => [String(o.application), o]));
  const upcoming = await Interview.find({ application: { $in: applications.map((a) => a._id) }, status: 'scheduled', scheduledDate: { $gte: new Date(Date.now() - 4 * 3600000) } }).sort({ scheduledDate: 1 }).select('application scheduledDate mode location round status provider externalUrl').lean();
  const interviewOf = new Map();
  for (const i of upcoming) if (!interviewOf.has(String(i.application))) interviewOf.set(String(i.application), i);
  // The latest finished interview, so the employer can choose the next step from its result.
  const done = await Interview.find({ application: { $in: applications.map((a) => a._id) }, status: 'completed' }).sort({ updatedAt: -1 }).select('application scheduledDate round result feedback').lean();
  const lastOf = new Map();
  for (const i of done) if (!lastOf.has(String(i.application))) lastOf.set(String(i.application), i);
  // Students referred by a partner institute (Placement Office).
  const refs = await require('../models/PlacementReferral').find({ application: { $in: applications.map((a) => a._id) } }).populate('institution', 'name').select('application institution').lean();
  const referredOf = new Map(refs.map((r) => [String(r.application), r.institution?.name || 'an institute']));
  return ok(res, applications.map((a) => ({ ...a.toObject(), employment: offerOf.get(String(a._id)) || null, referredBy: referredOf.get(String(a._id)) || null, nextInterview: interviewOf.get(String(a._id)) || null, lastInterview: lastOf.get(String(a._id)) || null, messageCount: (a.messages || []).length, messages: undefined })));
});

// PATCH /api/jobs/applications/:appId/status
// Master 12.10 Hiring Workflow, in stored values (see JobApplication): Applied (pending) →
// Screening (viewed) → Shortlisted → Interview → Final Interview → Offer (selected) → Accepted →
// Joined (hired) → Completed; Rejected and Withdrawn at any point.
const HIRING_STATUSES = ['pending', 'viewed', 'shortlisted', 'interview', 'final_interview', 'selected', 'accepted', 'hired', 'completed', 'rejected', 'withdrawn'];
const STAGE_LABEL = { pending: 'Applied', viewed: 'Screening', shortlisted: 'Shortlisted', interview: 'Interview', final_interview: 'Final interview', selected: 'Offer', accepted: 'Offer accepted', hired: 'Joined', completed: 'Completed', rejected: 'Not selected', withdrawn: 'Withdrawn' };

// Is the person updating this application the hiring organization itself (the employer or the
// institute), rather than an agent recruiting on someone else's behalf?
async function isHiringOrganization(job, user) {
  if (job.agreement) return false; // the institute confirms from its Agents tab (recruitment hires)
  if (job.institution) return jobAccess.canManageJob(job, user);
  if (String(job.postedBy) !== String(user._id) && !(await require('../services/employerStaff.service').hasPermission(user._id, job.postedBy, ['manage_applicants']))) return false;
  return (await publisherRole(job, user)) === 'employer';
}

// Runs once joining is confirmed: the job is filled and an agent's own placement earns its
// commission (existing Agent commission rule, Master 13).
async function onJoiningConfirmed(application, actorId) {
  const job = application.job;
  if (job.status !== 'filled') { job.status = 'filled'; await job.save(); }
  // An institute's hire becomes its staff (teacher for teaching jobs) right away.
  await require('../services/institutionHire.service').onInstituteJoining(application);
  const poster = await User.findById(job.postedBy).select('roles');
  if (!job.institution && poster?.roles?.includes('education_agent') && (await publisherRole(job, poster)) === 'education_agent') {
    const existing = await Commission.findOne({ application: application._id });
    const agentWork = require('../services/agentWork.service');
    const due = existing ? null : await agentWork.commissionFor(job, job.salaryMin || job.salaryMax || 0);
    if (due) {
      const commission = await Commission.create({ agent: job.postedBy, employer: due.employer, job: job._id, application: application._id, candidate: application.applicant, rate: due.rate, amount: due.amount, currency: job.currency || 'PKR' });
      await agentWork.tellEmployerToPay(commission, job.title);
      await notify(job.postedBy, { title: `Commission generated: ${commission.currency} ${commission.amount}`, body: `${job.title}: joining confirmed.`, sentBy: actorId, link: require('../utils/dashLinks').agentCommission, category: 'commission' }).catch(() => {});
    }
  }
}

const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!HIRING_STATUSES.includes(status)) throw new AppError('Invalid status.', 422);

  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  await assertOwnsJob(application.job, req.user);
  const hiringOrg = await isHiringOrganization(application.job, req.user);
  if (status === 'completed' && !(application.status === 'hired' && application.joining?.confirmed)) throw new AppError('Mark Completed only after joining is confirmed.', 409);
  if (status === 'withdrawn') throw new AppError('Only the candidate can withdraw an application.', 422);
  // Agent jobs: the institute selects candidates; the agent works only with the selected ones.
  if (application.job.agreement) {
    if (status === 'shortlisted' || status === 'viewed') throw new AppError('The institute selects candidates for this job. The agent works with the ones it selects.', 409);
    if (!application.institutionSelection?.at) throw new AppError('The institute has not selected this candidate yet.', 409);
  }
  // Agent jobs: the offer comes from the institute (Request offer) and the candidate accepts it.
  if (application.job.agreement && ['selected', 'accepted'].includes(status)) throw new AppError(status === 'selected' ? 'The institute makes the offer for this job. Use Request offer, then forward the offer from the institute to the candidate.' : 'The candidate accepts the offer from their dashboard.', 409);
  // The offer decides the later stages: accepted only after an offer; joined only once it is accepted.
  const Employment = require('../models/Employment');
  const offer = await Employment.findOne({ application: application._id });
  if (status === 'accepted' && offer?.status !== 'offered' && application.status !== 'accepted') throw new AppError('Make an offer first (Offer stage). The candidate accepts it from their dashboard.', 409);
  if (status === 'hired' && offer?.status === 'offered') throw new AppError('The candidate has not accepted the offer yet.', 409);
  if (status === 'hired' && offer && ['declined', 'withdrawn'].includes(offer.status)) throw new AppError('The offer was declined or withdrawn. Make a new offer first.', 409);

  const previousStatus = application.status;
  application.status = status;
  application.statusHistory.push({ status, by: req.user._id, byRole: hiringOrg ? 'hiring_organization' : 'agent', note });
  if (status === 'hired' && previousStatus !== 'hired') {
    application.joining = hiringOrg
      ? { confirmed: true, confirmedBy: req.user._id, confirmedAt: new Date(), via: 'hiring_organization' }
      : { confirmed: false, confirmedBy: null, confirmedAt: null, via: '' };
  }
  if (previousStatus === 'hired' && !['hired', 'completed'].includes(status)) application.joining = { confirmed: false, confirmedBy: null, confirmedAt: null, via: '' };
  await application.save();

  // The hire fell through — cancel the commission it generated rather than leaving a stale
  // "earned" record for a placement that no longer stands.
  if (['hired', 'completed'].includes(previousStatus) && !['hired', 'completed'].includes(status)) {
    await Commission.updateOne({ application: application._id, status: { $ne: 'paid' } }, { status: 'cancelled' });
  }

  // Side effects of the stage on the offer and interviews.
  if (offer && status === 'accepted' && offer.status === 'offered') { offer.status = 'accepted'; offer.respondedAt = new Date(); await offer.save(); }
  if (offer && status === 'completed') { offer.status = 'completed'; offer.endedAt = new Date(); offer.endReason = note || 'Completed'; await offer.save(); }
  if (status === 'rejected') {
    if (offer && ['offered', 'accepted'].includes(offer.status)) { offer.status = 'withdrawn'; offer.endReason = note || 'Offer withdrawn by the employer'; offer.endedAt = new Date(); await offer.save(); }
    await Interview.updateMany({ application: application._id, status: 'scheduled', scheduledDate: { $gte: new Date() } }, { $set: { status: 'cancelled' } });
  }
  const needsConfirmation = status === 'hired' && !application.joining.confirmed;
  const institutionConfirms = Boolean(application.job.agreement);
  if (needsConfirmation && institutionConfirms) {
    const { tellInstitution } = require('../services/recruitment.service');
    await tellInstitution(application.job.institution, { title: `Confirm joining: ${application.job.title}`, body: 'Your recruitment agent marked a candidate as joined. Confirm or decline in Jobs & Hiring → Agents.', link: '/dashboard', sentBy: req.user._id });
  }
  await notify(application.applicant, {
    title: `${application.job.title} @ ${application.job.company}: ${STAGE_LABEL[status]}`,
    body: needsConfirmation && institutionConfirms ? 'You were marked as joined. The institute will confirm it.' : needsConfirmation ? 'The recruiter marked you as joined. Please confirm in My Applications that you have joined.' : (note || `Your application is now at: ${STAGE_LABEL[status]}.`),
    sentBy: req.user._id, link: require('../utils/dashLinks').candidate(['interview','final_interview'].includes(application.status) ? 'interviews' : 'applications'), category: 'application'
  }, { email: true, emailPreference: 'applicationEmails', ctaLabel: 'View job' }).catch(() => {});

  if (status === 'shortlisted') await notify(req.user._id, { title: `Candidate shortlisted: ${application.job.title}`, sentBy: req.user._id }).catch(() => {});
  if (status === 'hired') {
    await notify(req.user._id, { title: needsConfirmation ? `Joining recorded, waiting for ${institutionConfirms ? 'the institute' : 'the candidate'} to confirm: ${application.job.title}` : `Candidate joined: ${application.job.title}`, sentBy: req.user._id }).catch(() => {});
    if (application.joining.confirmed) await onJoiningConfirmed(application, req.user._id);
    // A real employment record on top of the "joined" label (existing behaviour).
    const Employment = require('../models/Employment');
    const existingEmployment = await Employment.findOne({ application: application._id });
    if (existingEmployment?.status === 'accepted') { existingEmployment.status = 'active'; existingEmployment.startDate = existingEmployment.startDate || new Date(); await existingEmployment.save(); }
    if (!existingEmployment) {
      await Employment.create({ application: application._id, job: application.job._id, employer: application.job.postedBy, employee: application.applicant,
        salary: application.job.salaryMin || application.job.salaryMax || null, currency: application.job.currency || 'USD', status: 'offered' });
      await notify(application.applicant, { title: `Employment offer: ${application.job.title}`, body: 'Review and respond to the formal offer from My Applications.', sentBy: req.user._id }).catch(() => {});
    }
  }

  return ok(res, application, `Application moved to ${STAGE_LABEL[status]}.`);
});

// POST /api/jobs/applications/:appId/confirm-joining — the candidate confirms they joined, for a
// job an agent recruited for (Master 12.10 Joined; an agent's claim alone is not enough).
const confirmJoining = asyncHandler(async (req, res) => {
  const application = await JobApplication.findOne({ _id: req.params.appId, applicant: req.user._id }).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  if (application.status !== 'hired') throw new AppError('There is no joining to confirm for this application.', 409);
  if (application.joining?.confirmed) return ok(res, application, 'Joining already confirmed.');
  if (application.job.agreement) throw new AppError('The institute confirms joining for this job.', 409);
  application.joining = { confirmed: true, confirmedBy: req.user._id, confirmedAt: new Date(), via: 'candidate' };
  application.statusHistory.push({ status: 'hired', by: req.user._id, byRole: 'applicant', note: 'Candidate confirmed joining' });
  await application.save();
  await onJoiningConfirmed(application, req.user._id);
  await notify(application.job.postedBy, { title: `Joining confirmed: ${application.job.title}`, body: `${req.user.fullName} confirmed they joined.`, sentBy: req.user._id, link: require('../utils/dashLinks').manager(application.job), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  return ok(res, application, 'Thank you. Your joining is confirmed.');
});

// GET /api/jobs/applications/:appId/cv-file — the CV file sent with an application, for the
// people who manage that job and for the applicant.
const applicationCvFile = asyncHandler(async (req, res) => {
  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  if (String(application.applicant) !== String(req.user._id) && !(await jobAccess.canSeeCandidates(application.job, req.user))) throw new AppError('You cannot open this CV.', 403);
  const fileId = application.resumeSnapshot?.cvFile;
  const file = fileId ? await require('../models/PrivateFile').findById(fileId) : null;
  if (!file) throw new AppError('No CV file was sent with this application.', 404);
  return require('./resume.controller').sendPrivateFile(res, file);
});

// POST /api/jobs/applications/:appId/withdraw — the applicant withdraws before joining.
const withdrawApplication = asyncHandler(async (req, res) => {
  const application = await JobApplication.findOne({ _id: req.params.appId, applicant: req.user._id }).populate('job', 'title company postedBy');
  if (!application) throw new AppError('Application not found.', 404);
  if (['hired', 'completed', 'rejected', 'withdrawn'].includes(application.status)) throw new AppError(`This application is already ${STAGE_LABEL[application.status].toLowerCase()}.`, 409);
  application.status = 'withdrawn';
  application.statusHistory.push({ status: 'withdrawn', by: req.user._id, byRole: 'applicant', note: String(req.body?.reason || '').slice(0, 300) });
  await application.save();
  await notify(application.job.postedBy, { title: `Application withdrawn: ${application.job.title}`, body: `${req.user.fullName} withdrew their application.`, sentBy: req.user._id, link: require('../utils/dashLinks').manager(application.job), category: 'application' }).catch(() => {});
  return ok(res, application, 'Application withdrawn.');
});

// POST /api/jobs/applications/:appId/schedule-interview (employer)
const scheduleInterview = asyncHandler(async (req, res) => {
  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  await assertOwnsJob(application.job, req.user);
  if (application.job.agreement && !application.institutionSelection?.at) throw new AppError('The institute has not selected this candidate yet. You can interview only the candidates it selects.', 409);

  const { scheduledDate, mode, location } = req.body;
  if (!scheduledDate) throw new AppError('scheduledDate is required.', 422);
  const meeting = (mode || 'online') === 'online' ? require('../utils/meetingProviders').normalise(req.body.provider, req.body.externalUrl) : { provider: 'careerz', externalUrl: '' };
  const when = new Date(scheduledDate);
  if (Number.isNaN(when.getTime()) || when < new Date(Date.now() - 5 * 60000)) throw new AppError('Choose a future date and time for the interview.', 422);
  if (mode === 'physical' && !String(location || '').trim()) throw new AppError('Enter the interview address.', 422);
  const round = req.body.round === 'final_interview' ? 'final_interview' : 'interview';
  if (['hired', 'completed', 'rejected', 'withdrawn'].includes(application.status)) throw new AppError(`This application is already ${STAGE_LABEL[application.status].toLowerCase()}.`, 409);

  const interview = await Interview.create({
    application: application._id,
    job: application.job._id,
    candidate: application.applicant,
    scheduledBy: req.user._id,
    scheduledDate,
    mode: mode || 'online',
    location: location || '',
    meetingLink: meeting.externalUrl,
    provider: meeting.provider,
    externalUrl: meeting.externalUrl,
    round
  });
  // Built-in interviews open CareerZ's own video room; the link opens it inside the dashboard.
  if (interview.mode === 'online' && interview.provider === 'careerz') { interview.meetingLink = require('../services/interviewVideo.service').link(interview._id); await interview.save(); }

  application.status = round;
  application.statusHistory.push({ status: round, by: req.user._id, byRole: (await isHiringOrganization(application.job, req.user)) ? 'hiring_organization' : 'agent', note: `${STAGE_LABEL[round]} on ${when.toLocaleString()}` });
  await application.save();

  await notify(application.applicant, {
    title: `${round === 'final_interview' ? 'Final interview' : 'Interview'} scheduled: ${application.job.title} @ ${application.job.company}`,
    body: `${new Date(scheduledDate).toLocaleString()} — ${mode === 'physical' ? location : meeting.provider === 'careerz' ? 'online on CareerZ (join from Jobs & Applications → Interviews)' : `online on ${require('../utils/meetingProviders').PROVIDERS[meeting.provider].label}: ${meeting.externalUrl}`}`,
    sentBy: req.user._id, link: require('../utils/dashLinks').candidate(['interview','final_interview'].includes(application.status) ? 'interviews' : 'applications'), category: 'application'
  }, { email: true, emailPreference: 'applicationEmails', ctaLabel: 'View job' }).catch(() => {});

  return created(res, interview, 'Interview scheduled.');
});

// PATCH /api/jobs/interviews/:id — Reschedule, Cancel, and Add Feedback all use this one
// endpoint (same "allowed fields" pattern as everywhere else) — only the person who scheduled
// it can change it.
const updateInterview = asyncHandler(async (req, res) => {
  const interview = await Interview.findById(req.params.id).populate('job', 'title company postedBy institution');
  if (!interview) throw new AppError('Interview not found.', 404);
  if (interview.scheduledBy.toString() !== req.user._id.toString() && !(await jobAccess.canManageJob(interview.job, req.user))) throw new AppError('You cannot change this interview.', 403);

  const { scheduledDate, mode, location, status, feedback } = req.body;
  const isReschedule = scheduledDate !== undefined && new Date(scheduledDate).getTime() !== interview.scheduledDate.getTime();

  if (scheduledDate !== undefined) interview.scheduledDate = scheduledDate;
  if (mode !== undefined) interview.mode = mode;
  if (location !== undefined) interview.location = location;
  if (interview.mode === 'online' && (req.body.provider !== undefined || req.body.externalUrl !== undefined)) {
    const next = require('../utils/meetingProviders').normalise(req.body.provider ?? interview.provider, req.body.externalUrl ?? interview.externalUrl);
    interview.provider = next.provider; interview.externalUrl = next.externalUrl;
  }
  if (interview.mode !== 'online') { interview.provider = 'careerz'; interview.externalUrl = ''; }
  interview.meetingLink = interview.mode !== 'online' ? '' : interview.provider === 'careerz' ? require('../services/interviewVideo.service').link(interview._id) : interview.externalUrl;
  if (status !== undefined) {
    if (!['scheduled', 'completed', 'cancelled'].includes(status)) throw new AppError('Invalid status.', 422);
    interview.status = status;
  }
  if (feedback !== undefined) {
    interview.feedback = feedback;
    interview.status = 'completed'; // giving feedback implies the interview actually happened
  }
  if (req.body.result !== undefined) {
    if (!['passed', 'not_passed', 'no_show'].includes(req.body.result)) throw new AppError('Choose passed, not passed or did not come.', 422);
    interview.result = req.body.result;
    interview.status = 'completed';
  }
  await interview.save();

  if (isReschedule) {
    await notify(interview.candidate, {
      title: `Interview rescheduled: ${interview.job.title} @ ${interview.job.company}`,
      body: `New time: ${new Date(interview.scheduledDate).toLocaleString()}`,
      sentBy: req.user._id
    }).catch(() => {});
  } else if (status === 'cancelled') {
    await notify(interview.candidate, {
      title: `Interview cancelled: ${interview.job.title} @ ${interview.job.company}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, interview, 'Interview updated.');
});

// GET /api/jobs/mine/interviews (candidate)
const myInterviews = asyncHandler(async (req, res) => {
  const interviews = await Interview.find({ candidate: req.user._id })
    .populate('job', 'title company city country type workMode salaryMin salaryMax currency experienceYears education skills description applicationDeadline visaSponsorship companyLogo contactEmail contactPhone createdAt')
    .sort({ scheduledDate: 1 });
  return ok(res, interviews);
});

// GET /api/jobs/mine/scheduled-interviews — Employer/Agent side: interviews they scheduled.
const myScheduledInterviews = asyncHandler(async (req, res) => {
  const interviews = await Interview.find({ scheduledBy: req.user._id })
    .populate('candidate', 'fullName')
    .populate('job', 'title company')
    .sort({ scheduledDate: 1 });
  return ok(res, interviews);
});

// GET /api/jobs/mine/dashboard — the job-seeker mini-dashboard inside the Jobs tab.
const getMyJobDashboard = asyncHandler(async (req, res) => {
  const [resume, applications, savedUser, interviews, recentInterviews] = await Promise.all([
    Resume.findOne({ user: req.user._id }),
    JobApplication.find({ applicant: req.user._id }).populate('job', 'title company city country type status applicationDeadline').sort({ createdAt: -1 }),
    User.findById(req.user._id).populate('savedJobs').populate('recentlyViewedJobs.job', 'title company'),
    Interview.find({ candidate: req.user._id, status: 'scheduled', scheduledDate: { $gte: new Date() } }).populate('job', 'title company city country type workMode salaryMin salaryMax currency experienceYears education skills description applicationDeadline visaSponsorship companyLogo contactEmail contactPhone createdAt').sort({ scheduledDate: 1 }).limit(5),
    Interview.find({ candidate: req.user._id }).populate('job', 'title company').sort({ createdAt: -1 }).limit(5)
  ]);

  const savedJobs = (savedUser.savedJobs || []).filter(Boolean);
  const recentlyViewedJobs = (savedUser.recentlyViewedJobs || [])
    .filter((v) => v.job)
    .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
    .slice(0, 5);

  // "Job deadline reminder" — checked on real page load (this codebase has no cron/scheduler),
  // for jobs the candidate applied to (still active) or saved, closing within 3 days.
  // Dedupe by title so refreshing the dashboard doesn't re-notify for the same job.
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const activeApps = applications.filter((a) => !['rejected', 'hired', 'completed', 'withdrawn'].includes(a.status)).map((a) => a.job).filter(Boolean);
  const deadlineCandidates = [...activeApps, ...savedJobs];
  const seenJobIds = new Set();
  for (const j of deadlineCandidates) {
    if (!j.applicationDeadline || seenJobIds.has(j._id.toString())) continue;
    seenJobIds.add(j._id.toString());
    const deadline = new Date(j.applicationDeadline);
    if (deadline > now && deadline <= soon) {
      const title = `Application deadline approaching: ${j.title}`;
      const alreadyNotified = await Notification.findOne({ user: req.user._id, title });
      if (!alreadyNotified) {
        await notify(req.user._id, { title, body: `Applications for ${j.title} @ ${j.company} close ${deadline.toLocaleDateString()}.`, sentBy: null }).catch(() => {});
      }
    }
  }

  const recommended = await Job.find({
    status: 'active',
    _id: { $nin: applications.map((a) => a.job?._id).filter(Boolean) },
    ...(resume?.skills?.length ? { skills: { $in: resume.skills } } : {})
  }).sort({ createdAt: -1 }).limit(20);

  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(8);

  const resumeFieldsFilled = resume ? [
    resume.headline, resume.summary, resume.location, resume.experienceLevel,
    resume.education?.length > 0, resume.experience?.length > 0, resume.skills?.length > 0
  ].filter(Boolean).length : 0;
  const cvCompleteness = Math.round((resumeFieldsFilled / 7) * 100);

  // Missing/recommended skills — real signal from what the current open-job market is asking
  // for, not a fabricated list: count skill frequency across the latest open postings and
  // subtract whatever the candidate already has on their CV.
  const marketJobs = await Job.find({ status: 'active' }).select('skills').sort({ createdAt: -1 }).limit(50);
  const skillFreq = {};
  marketJobs.forEach((j) => (j.skills || []).forEach((s) => { skillFreq[s] = (skillFreq[s] || 0) + 1; }));
  const mySkillsLower = new Set((resume?.skills || []).map((s) => s.toLowerCase()));
  const missingSkills = Object.entries(skillFreq)
    .filter(([s]) => !mySkillsLower.has(s.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s]) => s);

  return ok(res, {
    profile: {
      title: resume?.headline || '',
      location: resume?.location || '',
      experienceLevel: resume?.experienceLevel || '',
      completeness: cvCompleteness,
      profileViews: resume?.viewCount || 0,
      skills: resume?.skills || [],
      missingSkills,
      education: resume?.education || [],
      experience: resume?.experience || [],
      certifications: resume?.certifications || [],
      portfolio: resume?.portfolio || [],
      linkedinUrl: resume?.linkedinUrl || ''
    },
    counts: {
      recommended: recommended.length,
      saved: savedJobs.length,
      applied: applications.length,
      interviews: applications.filter((a) => a.status === 'interview').length,
      offers: applications.filter((a) => a.status === 'hired').length
    },
    recommendedJobs: recommended,
    applications: applications.slice(0, 10),
    upcomingInterviews: interviews,
    savedJobs,
    cvCompleteness,
    cvLastUpdated: resume?.updatedAt || null,
    cvFileUrl: resume?.cvFileUrl || '',
    notifications,
    recentActivity: {
      recentlyViewedJobs: recentlyViewedJobs.map((v) => ({ job: v.job, viewedAt: v.viewedAt })),
      savedJobs: savedJobs.slice(0, 5),
      submittedApplications: applications.slice(0, 5),
      cvLastUpdated: resume?.updatedAt || null,
      recentInterviews,
      receivedOffers: applications.filter((a) => a.status === 'hired').slice(0, 5)
    }
  });
});

// POST /api/jobs/:id/save
const saveJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  await User.updateOne({ _id: req.user._id }, { $addToSet: { savedJobs: job._id } });
  return ok(res, null, 'Job saved.');
});

// DELETE /api/jobs/:id/save
const unsaveJob = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $pull: { savedJobs: req.params.id } });
  return ok(res, null, 'Job removed from saved list.');
});

// GET /api/jobs/mine/saved
const listSavedJobs = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('savedJobs');
  return ok(res, (user.savedJobs || []).filter(Boolean));
});

const FEATURED_JOB_FEE_KEY = 'featured_job_fee_usd';
const DEFAULT_FEATURED_JOB_FEE = 20;
const FEATURED_JOB_DAYS = 30;

// GET /api/jobs/featured-fee — any authenticated user (employer/agent needs to see the price
// before buying).
const getFeaturedFee = asyncHandler(async (req, res) => {
  const setting = await Setting.findOne({ key: FEATURED_JOB_FEE_KEY });
  return ok(res, { fee: setting ? setting.value : DEFAULT_FEATURED_JOB_FEE, currency: 'USD', days: FEATURED_JOB_DAYS });
});

// PATCH /api/jobs/featured-fee — Super Admin only.
const setFeaturedFee = asyncHandler(async (req, res) => {
  const { fee } = req.body;
  if (typeof fee !== 'number' || fee < 0) throw new AppError('fee must be a non-negative number.', 422);
  const setting = await Setting.findOneAndUpdate({ key: FEATURED_JOB_FEE_KEY }, { key: FEATURED_JOB_FEE_KEY, value: fee }, { new: true, upsert: true });
  return ok(res, { fee: setting.value }, 'Featured job fee updated.');
});

// Shared validation for both the JazzCash checkout (jazzcash.controller.js) and the
// Admin-recorded manual entry below — the poster must own the job, and it can't already be
// under an active featured window.
async function loadFeaturableJob(jobId, userId) {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError('Job not found.', 404);
  await assertOwnsJob(job, userId);
  if (job.featured && job.featuredUntil > new Date()) throw new AppError('This job is already featured.', 400);
  const setting = await Setting.findOne({ key: FEATURED_JOB_FEE_KEY });
  const fee = setting ? setting.value : DEFAULT_FEATURED_JOB_FEE;
  return { job, fee, days: FEATURED_JOB_DAYS };
}

// POST /api/jobs/:id/feature — Admin-only: records a Featured purchase the poster paid for
// off-platform (bank transfer/cash), same self-report pattern as institution fees. Regular
// employers/agents must use the JazzCash checkout (jazzcash.controller.js
// createFeaturedJobCheckout) — a self-service "trust me I paid" button was exactly the gap that
// let anyone activate a paid placement without a verified charge.
const featureJob = asyncHandler(async (req, res) => {
  const { paymentMethod, reference, proofUrl } = req.body;
  if (!paymentMethod || !PAYMENT_METHOD_LABEL[paymentMethod]) {
    throw new AppError('A valid paymentMethod is required (bank_transfer, mobile_wallet, cash or other).', 422);
  }
  if (!String(reference || '').trim()) throw new AppError('External payment reference or cash receipt number is required.', 422);
  if (paymentMethod !== 'cash' && !String(proofUrl || '').trim()) throw new AppError('Payment proof is required.', 422);

  const { job, fee, days } = await loadFeaturableJob(req.params.id, req.user._id);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const transactionId = generateTransactionId();

  const FeaturedListing = require('../models/FeaturedListing');
  await FeaturedListing.create({
    listingType: 'job', job: job._id, purchasedBy: job.postedBy, amount: fee, currency: 'USD',
    paymentMethod, transactionId, paymentReference: String(reference).trim(), paymentProofUrl: String(proofUrl || '').trim(),
    verifiedBy: req.user._id, verifiedAt: new Date(), status: 'paid', expiresAt
  });

  job.featured = true;
  job.featuredUntil = expiresAt;
  await job.save();

  return ok(res, job, `Job featured for ${days} days (${fee} USD). Receipt ${transactionId}`);
});

module.exports = {
  confirmJoining, withdrawApplication, HIRING_STATUSES, isHiringOrganization, applicationCvFile,
  smartApplyMatches, smartApply,
  createJob,
  loadFeaturableJob,
  getFeaturedFee,
  setFeaturedFee,
  featureJob,
  listJobs,
  getJob,
  myJobs,
  myJobsSummary,
  myRecentActivity,
  updateJob,
  applyToJob,
  myApplications,
  listApplicants,
  listRecommendedCandidates,
  shortlistCandidate,
  updateApplicationStatus,
  scheduleInterview,
  updateInterview,
  myInterviews,
  myScheduledInterviews,
  getMyJobDashboard,
  saveJob,
  unsaveJob,
  listSavedJobs
};
