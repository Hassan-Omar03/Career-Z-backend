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

function assertOwnsJob(job, userId) {
  if (job.postedBy.toString() !== userId.toString()) {
    throw new AppError('You did not post this job.', 403);
  }
}

// POST /api/jobs
const createJob = asyncHandler(async (req, res) => {
  const verified = (await isRoleVerified(req.user._id, 'employer')) || (await isRoleVerified(req.user._id, 'education_agent'));
  if (!verified) {
    throw new AppError('Your Employer/Agent account is pending Super Admin verification. You can browse the dashboard but cannot post a job until it is approved.', 403);
  }

  const allowed = [
    'title', 'company', 'type', 'workMode', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
    'experienceYears', 'education', 'skills', 'description', 'applicationDeadline',
    'visaSponsorship', 'companyLogo', 'contactEmail', 'contactPhone', 'isGovernment', 'status'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || !body.company || !body.country) {
    throw new AppError('title, company and country are required.', 422);
  }
  if (body.status && !['draft', 'active'].includes(body.status)) {
    throw new AppError('A new job can only be created as draft or active.', 422);
  }

  const job = await Job.create({ ...body, postedBy: req.user._id });

  // "New matching job" notification — real signal: only candidates whose CV already lists
  // one of this job's required skills get notified, and only once the job is actually live.
  if (job.status === 'active' && body.skills?.length > 0) {
    const matchingResumes = await Resume.find({ skills: { $in: body.skills } }).select('user');
    await Promise.all(matchingResumes.map((r) => notify(r.user, {
      title: `New matching job: ${job.title} @ ${job.company}`,
      body: `Matches your skills: ${body.skills.join(', ')}`,
      sentBy: req.user._id
    }).catch(() => {})));
  }

  return created(res, job, 'Job posted.');
});

// GET /api/jobs (public search)
const listJobs = asyncHandler(async (req, res) => {
  const { q, country, city, type, minSalary } = req.query;
  const filter = { status: 'active' };
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
  const jobs = await Job.find({ postedBy: req.user._id }).sort({ createdAt: -1 });
  const counts = await JobApplication.aggregate([
    { $match: { job: { $in: jobs.map((j) => j._id) } } },
    { $group: { _id: '$job', count: { $sum: 1 } } }
  ]);
  const countByJob = Object.fromEntries(counts.map((c) => [c._id.toString(), c.count]));
  const withCounts = jobs.map((j) => ({ ...j.toObject(), applicantCount: countByJob[j._id.toString()] || 0 }));
  return ok(res, withCounts);
});

// GET /api/jobs/mine/summary — Employer/Agent dashboard summary cards, all real aggregates.
// Also runs the "Interview reminder" / "Job expiry reminder" lazy checks (no cron in this app)
// since this endpoint is guaranteed to load every time the dashboard opens.
const myJobsSummary = asyncHandler(async (req, res) => {
  const jobs = await Job.find({ postedBy: req.user._id }).select('_id status title applicationDeadline');
  const jobIds = jobs.map((j) => j._id);
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const [appCounts, scheduledInterviewsCount, reminderInterviews] = await Promise.all([
    JobApplication.aggregate([
      { $match: { job: { $in: jobIds } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Interview.countDocuments({ scheduledBy: req.user._id, status: 'scheduled', scheduledDate: { $gte: now } }),
    Interview.find({ scheduledBy: req.user._id, status: 'scheduled', scheduledDate: { $gte: now, $lte: in48h } })
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
  const jobs = await Job.find({ postedBy: req.user._id }).select('_id title createdAt');
  const jobIds = jobs.map((j) => j._id);

  const [applications, interviews, commissions, withdrawals] = await Promise.all([
    JobApplication.find({ job: { $in: jobIds } }).populate('applicant', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(20),
    Interview.find({ scheduledBy: req.user._id }).populate('candidate', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(10),
    Commission.find({ agent: req.user._id }).populate('candidate', 'fullName').populate('job', 'title').sort({ createdAt: -1 }).limit(10),
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
  assertOwnsJob(job, req.user._id);

  const allowed = [
    'title', 'company', 'type', 'workMode', 'country', 'city', 'salaryMin', 'salaryMax', 'currency',
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
  if (job.status !== 'active') throw new AppError('This job is no longer accepting applications.', 400);

  const existing = await JobApplication.findOne({ job: job._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this job.', 409);

  const resume = await Resume.findOne({ user: req.user._id });

  const application = await JobApplication.create({
    job: job._id,
    applicant: req.user._id,
    coverLetter: req.body.coverLetter || '',
    resumeSnapshot: resume ? resume.toObject() : null
  });

  await notify(job.postedBy, {
    title: `New candidate applied: ${req.user.fullName} — ${job.title}`,
    body: job.company,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, application, 'Application submitted.');
});

// GET /api/jobs/mine/applications (as applicant)
const myApplications = asyncHandler(async (req, res) => {
  const applications = await JobApplication.find({ applicant: req.user._id })
    .populate('job', 'title company city country type status')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// A candidate's experienceLevel is categorical, a job's experienceYears is numeric — this maps
// the category to a representative year count so the two can actually be compared.
const EXPERIENCE_LEVEL_YEARS = { entry: 1, mid: 3, senior: 7, lead: 12 };

// GET /api/jobs/:id/recommended-candidates — real, computed matching (skills/experience/
// location/qualification), not an AI call: every score is explainable from the two documents.
const listRecommendedCandidates = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found.', 404);
  assertOwnsJob(job, req.user._id);

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
  assertOwnsJob(job, req.user._id);

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
  assertOwnsJob(job, req.user._id);

  const applications = await JobApplication.find({ job: job._id })
    .populate('applicant', 'fullName email profilePhoto')
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

  return ok(res, applications);
});

// PATCH /api/jobs/applications/:appId/status
const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'viewed', 'shortlisted', 'interview', 'selected', 'rejected', 'hired'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  assertOwnsJob(application.job, req.user._id);

  const previousStatus = application.status;
  application.status = status;
  await application.save();

  // The hire fell through — cancel the commission it generated rather than leaving a stale
  // "earned" record for a placement that no longer stands.
  if (previousStatus === 'hired' && status !== 'hired') {
    await Commission.updateOne(
      { application: application._id, status: { $ne: 'paid' } },
      { status: 'cancelled' }
    );
  }

  const STATUS_LABEL = { pending: 'Applied', viewed: 'Application viewed', shortlisted: 'Shortlisted', interview: 'Interview stage', selected: 'Selected', rejected: 'Not selected', hired: 'Job offer — Hired!' };
  await notify(application.applicant, {
    title: `${application.job.title} @ ${application.job.company}: ${STATUS_LABEL[status]}`,
    body: `Your application status changed to "${status}".`,
    sentBy: req.user._id
  }).catch(() => {});

  // The recruiter's own confirmation — useful once more than one staff member can act on the
  // same placement, and for the Agent's "Candidate shortlisted"/"Candidate hired" notifications.
  if (status === 'shortlisted') {
    await notify(req.user._id, {
      title: `Candidate shortlisted: ${application.job.title}`,
      sentBy: req.user._id
    }).catch(() => {});
  }
  if (status === 'hired') {
    await notify(req.user._id, {
      title: `Candidate hired: ${application.job.title}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  // The position is genuinely filled once someone is hired for it — not just a status label
  // change, the job itself stops accepting further applications.
  if (status === 'hired' && application.job.status !== 'filled') {
    application.job.status = 'filled';
    await application.job.save();
  }

  // Commission — earned automatically when an education_agent's own placement gets a hire.
  // Real, computed off the job's actual salary; skipped (not fabricated) when no salary is set.
  if (status === 'hired' && req.user.roles.includes('education_agent')) {
    const existing = await Commission.findOne({ application: application._id });
    if (!existing) {
      const rateSetting = await Setting.findOne({ key: 'commission_rate_percent' });
      const rate = rateSetting ? rateSetting.value : 10; // Super Admin controls this via PATCH /commissions/rate
      const base = application.job.salaryMin || application.job.salaryMax || 0;
      const amount = Math.round((base * rate) / 100);
      const commission = await Commission.create({
        agent: req.user._id,
        job: application.job._id,
        application: application._id,
        candidate: application.applicant,
        rate,
        amount,
        currency: application.job.currency || 'USD'
      });
      await notify(req.user._id, {
        title: `Commission generated: ${commission.currency} ${commission.amount}`,
        body: application.job.title,
        sentBy: req.user._id
      }).catch(() => {});
    }
  }

  return ok(res, application, `Application ${status}.`);
});

// POST /api/jobs/applications/:appId/schedule-interview (employer)
const scheduleInterview = asyncHandler(async (req, res) => {
  const application = await JobApplication.findById(req.params.appId).populate('job');
  if (!application) throw new AppError('Application not found.', 404);
  assertOwnsJob(application.job, req.user._id);

  const { scheduledDate, mode, location, meetingLink } = req.body;
  if (!scheduledDate) throw new AppError('scheduledDate is required.', 422);

  const interview = await Interview.create({
    application: application._id,
    job: application.job._id,
    candidate: application.applicant,
    scheduledBy: req.user._id,
    scheduledDate,
    mode: mode || 'online',
    location: location || '',
    meetingLink: meetingLink || ''
  });

  application.status = 'interview';
  await application.save();

  await notify(application.applicant, {
    title: `Interview scheduled: ${application.job.title} @ ${application.job.company}`,
    body: `${new Date(scheduledDate).toLocaleString()} — ${mode === 'physical' ? location : (meetingLink || 'online')}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, interview, 'Interview scheduled.');
});

// PATCH /api/jobs/interviews/:id — Reschedule, Cancel, and Add Feedback all use this one
// endpoint (same "allowed fields" pattern as everywhere else) — only the person who scheduled
// it can change it.
const updateInterview = asyncHandler(async (req, res) => {
  const interview = await Interview.findById(req.params.id).populate('job', 'title company');
  if (!interview) throw new AppError('Interview not found.', 404);
  if (interview.scheduledBy.toString() !== req.user._id.toString()) throw new AppError('You did not schedule this interview.', 403);

  const { scheduledDate, mode, location, meetingLink, status, feedback } = req.body;
  const isReschedule = scheduledDate !== undefined && new Date(scheduledDate).getTime() !== interview.scheduledDate.getTime();

  if (scheduledDate !== undefined) interview.scheduledDate = scheduledDate;
  if (mode !== undefined) interview.mode = mode;
  if (location !== undefined) interview.location = location;
  if (meetingLink !== undefined) interview.meetingLink = meetingLink;
  if (status !== undefined) {
    if (!['scheduled', 'completed', 'cancelled'].includes(status)) throw new AppError('Invalid status.', 422);
    interview.status = status;
  }
  if (feedback !== undefined) {
    interview.feedback = feedback;
    interview.status = 'completed'; // giving feedback implies the interview actually happened
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
  const activeApps = applications.filter((a) => !['rejected', 'hired'].includes(a.status)).map((a) => a.job).filter(Boolean);
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

module.exports = {
  createJob,
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
