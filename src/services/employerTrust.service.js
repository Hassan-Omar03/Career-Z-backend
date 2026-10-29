const mongoose = require('mongoose');
const CompanyReview = require('../models/CompanyReview');
const EmployerFraudCase = require('../models/EmployerFraudCase');
const Employment = require('../models/Employment');
const Job = require('../models/Job');
const User = require('../models/User');
const RoleRequest = require('../models/RoleRequest');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify, notifyAdmins } = require('./notification.service');

const fail = (message, status = 422) => new AppError(message, status);
const oid = (id) => mongoose.isValidObjectId(id);
const clip = (v, n) => String(v || '').trim().slice(0, n);
const REVIEW_LINK = '/dashboard?tab=jobs&sub=companyReviews';

// ---------------------------------------------------------------- Employee reviews (12.16)

// Only an employer's own jobs: an institute's job (or one an agent filled for an institute) is not a company review.
async function isEmployerJob(employment) {
  const job = await Job.findById(employment.job).select('institution agreement').lean();
  if (!job || job.institution || job.agreement) return false;
  return Boolean(await User.exists({ _id: employment.employer, roles: 'employer' }));
}

// Employments the user really worked in and has not reviewed yet.
async function reviewable(user) {
  const done = await CompanyReview.distinct('employment', { reviewer: user._id });
  const rows = await Employment.find({ employee: user._id, status: { $in: ['active', 'resigned', 'terminated'] }, _id: { $nin: done } })
    .populate('employer', 'fullName').populate('job', 'title company').select('employer job application status startDate startedAt createdAt').lean();
  const out = [];
  for (const e of rows) if (await isEmployerJob({ job: e.job?._id, employer: e.employer?._id })) out.push(e);
  return out;
}

// Fake review detection: each matching rule holds the review for an admin's evidence review.
async function autoFlags(user, employment, { comment, rating }) {
  const out = [];
  const add = (code, label) => out.push({ code, label });
  const started = employment.startedAt || employment.startDate || employment.createdAt;
  if (started && Date.now() - new Date(started).getTime() < 14 * 864e5) add('too_early', 'Worked there less than 14 days');
  if (user.createdAt && Date.now() - new Date(user.createdAt).getTime() < 7 * 864e5) add('new_account', 'Reviewer account is less than 7 days old');
  if (/(https?:\/\/|www\.)|\+?\d[\d\s-]{9,}/i.test(comment)) add('contact_or_link', 'Contains a link or phone number');
  if (comment.length < 30 && (rating === 1 || rating === 5)) add('thin_extreme', 'Very short review with an extreme rating');
  if (comment.length > 20 && comment === comment.toUpperCase() && /[A-Z]/.test(comment)) add('shouting', 'Written all in capitals');
  const letters = comment.toLowerCase().replace(/[^a-z]/g, '');
  if (/(.)\1{5,}/.test(comment) || (letters.length >= 20 && new Set(letters).size < 7) || !/\b[a-z]{2,}\s+[a-z]{2,}\b/i.test(comment)) add('gibberish', 'Looks like random or repeated letters');
  if (await CompanyReview.exists({ comment, reviewer: { $ne: user._id } })) add('duplicate_text', 'Same text as another review');
  if ((await CompanyReview.countDocuments({ reviewer: user._id, createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } })) >= 3) add('many_reviews', 'Reviewer wrote 3+ reviews this week');
  return out;
}

async function createReview(user, body = {}) {
  if (!oid(body.employment)) throw fail('Choose the job you are reviewing.');
  const employment = await Employment.findOne({ _id: body.employment, employee: user._id }).populate('job', 'title');
  if (!employment) throw fail('Employment not found.', 404);
  if (!['active', 'resigned', 'terminated'].includes(employment.status)) throw fail('You can review a company only after you have joined it.', 409);
  if (!(await isEmployerJob(employment))) throw fail('Only jobs with an employer company can be reviewed here.', 409);
  if (await CompanyReview.exists({ employment: employment._id })) throw fail('You already reviewed this job.', 409);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail('Give a rating from 1 to 5 stars.');
  const comment = clip(body.comment, 3000);
  if (comment.length < 10) throw fail('Write a few lines about working there.');
  const salaryOnTime = body.salaryOnTime === true || body.salaryOnTime === false ? body.salaryOnTime : null;
  const flags = await autoFlags(user, employment, { comment, rating });
  const review = await CompanyReview.create({
    employer: employment.employer, reviewer: user._id, employment: employment._id, rating, title: clip(body.title, 120), comment,
    salaryOnTime, evidenceNote: clip(body.evidenceNote, 1000), flags, status: flags.length ? 'pending' : 'published'
  });
  if (review.status === 'published') await notify(employment.employer, { title: `New company review: ${rating}★`, body: review.title || comment.slice(0, 120), link: '/dashboard?ws=employer&tab=reviews', category: 'employer_review' }).catch(() => {});
  else await notifyAdmins({ title: 'Company review waiting for evidence review', body: flags.map((f) => f.label).join('; ') }).catch(() => {});
  return review;
}

const publicShape = (r) => ({
  _id: r._id, rating: r.rating, title: r.title, comment: r.comment, salaryOnTime: r.salaryOnTime, createdAt: r.createdAt,
  jobTitle: r.employment?.job?.title || '', reviewer: 'Verified employee', employerResponse: r.employerResponse?.text ? r.employerResponse : null
});

async function myReviews(user) {
  return CompanyReview.find({ reviewer: user._id }).populate('employer', 'fullName').populate({ path: 'employment', select: 'job application', populate: { path: 'job', select: 'title' } }).sort({ createdAt: -1 }).lean();
}

// The employer sees published reviews (and any they reported), never the reviewer's identity.
async function employerReviews(user) {
  const rows = await CompanyReview.find({ employer: user._id, $or: [{ status: 'published' }, { 'report.at': { $ne: null } }] })
    .populate({ path: 'employment', select: 'job', populate: { path: 'job', select: 'title' } }).sort({ createdAt: -1 }).lean();
  return rows.map((r) => ({ ...publicShape(r), status: r.status, report: r.report, appeal: { by: r.appeal?.by, status: r.appeal?.status, note: r.appeal?.note }, moderationNote: r.moderation?.note || '' }));
}

async function employerReview(user, id) {
  if (!oid(id)) throw fail('Review not found.', 404);
  const r = await CompanyReview.findOne({ _id: id, employer: user._id });
  if (!r) throw fail('Review not found.', 404);
  return r;
}

async function respond(user, id, text) {
  const r = await employerReview(user, id);
  if (r.status !== 'published') throw fail('You can answer only a published review.', 409);
  r.employerResponse = { text: clip(text, 1500), at: new Date() };
  if (!r.employerResponse.text) throw fail('Write your answer.');
  await r.save();
  return r;
}

async function report(user, id, reason) {
  const r = await employerReview(user, id);
  if (r.status !== 'published') throw fail('Only a published review can be reported.', 409);
  if (r.report?.at) throw fail('You already reported this review.', 409);
  const text = clip(reason, 1000);
  if (text.length < 10) throw fail('Explain why the review is false or unfair.');
  r.report = { reason: text, at: new Date(), open: true };
  await r.save();
  await notifyAdmins({ title: 'Employer reported a company review', body: text.slice(0, 200) }).catch(() => {});
  return r;
}

// One appeal per review: the reviewer if it was hidden, the employer if their report was rejected.
async function appeal(user, id, text) {
  if (!oid(id)) throw fail('Review not found.', 404);
  const r = await CompanyReview.findById(id);
  if (!r) throw fail('Review not found.', 404);
  const side = String(r.reviewer) === String(user._id) ? 'reviewer' : String(r.employer) === String(user._id) ? 'employer' : null;
  if (!side) throw fail('Review not found.', 404);
  if (r.appeal?.by) throw fail('This review was already appealed once.', 409);
  if (side === 'reviewer' && r.status !== 'hidden') throw fail('You can appeal only when your review was hidden.', 409);
  if (side === 'employer' && !(r.report?.at && !r.report.open && r.status === 'published')) throw fail('You can appeal after CareerZ keeps a review you reported.', 409);
  const t = clip(text, 1500);
  if (t.length < 10) throw fail('Explain your appeal.');
  r.appeal = { by: side, text: t, at: new Date(), status: 'pending' };
  await r.save();
  await notifyAdmins({ title: 'Company review appeal', body: t.slice(0, 200) }).catch(() => {});
  return r;
}

// Admin: the moderation queue (held reviews, open reports, pending appeals).
async function adminQueue() {
  return CompanyReview.find({ $or: [{ status: 'pending' }, { 'report.open': true }, { 'appeal.status': 'pending' }] })
    .populate('employer', 'fullName email').populate('reviewer', 'fullName email')
    .populate({ path: 'employment', select: 'job status startDate startedAt endedAt', populate: { path: 'job', select: 'title' } }).sort({ updatedAt: -1 }).lean();
}

async function adminDecide(admin, id, { status, note }) {
  if (!['published', 'hidden'].includes(status)) throw fail('Choose publish or hide.');
  if (!oid(id)) throw fail('Review not found.', 404);
  const r = await CompanyReview.findById(id);
  if (!r) throw fail('Review not found.', 404);
  r.status = status;
  r.moderation = { by: admin._id, at: new Date(), note: clip(note, 500) };
  if (r.report?.open) r.report.open = false;
  await r.save();
  await notify(r.reviewer, { title: status === 'published' ? 'Your company review is published' : 'Your company review was hidden', body: r.moderation.note || (status === 'hidden' ? 'You may appeal once from My Reviews.' : ''), link: REVIEW_LINK, category: 'employer_review' }).catch(() => {});
  if (r.report?.at) await notify(r.employer, { title: status === 'hidden' ? 'A review you reported was removed' : 'A review you reported was kept', body: r.moderation.note, link: '/dashboard?ws=employer&tab=reviews', category: 'employer_review' }).catch(() => {});
  return r;
}

async function adminDecideAppeal(admin, id, { upheld, note }) {
  if (!oid(id)) throw fail('Review not found.', 404);
  const r = await CompanyReview.findById(id);
  if (r?.appeal?.status !== 'pending') throw fail('No pending appeal on this review.', 404);
  r.appeal.status = upheld ? 'upheld' : 'rejected';
  r.appeal.decidedBy = admin._id;
  r.appeal.decidedAt = new Date();
  r.appeal.note = clip(note, 500);
  if (upheld) r.status = r.appeal.by === 'reviewer' ? 'published' : 'hidden';
  await r.save();
  await notify(r.appeal.by === 'reviewer' ? r.reviewer : r.employer, { title: `Your review appeal was ${upheld ? 'accepted' : 'rejected'}`, body: r.appeal.note, category: 'employer_review' }).catch(() => {});
  return r;
}

// AI moderation on the admin's own AI provider: a second opinion, never an automatic decision.
async function adminAiCheck(admin, id) {
  if (!oid(id)) throw fail('Review not found.', 404);
  const r = await CompanyReview.findById(id);
  if (!r) throw fail('Review not found.', 404);
  const text = await require('./ai.service').generate(admin._id,
    'You moderate employee reviews of companies. Decide if a review looks fake, abusive, off-topic or contains private data. Reply ONLY with JSON: {"verdict":"ok|suspicious|remove","reason":""}',
    `Rating: ${r.rating}/5\nTitle: ${r.title}\nReview: ${r.comment}\nEvidence note: ${r.evidenceNote}\nAutomatic flags: ${r.flags.map((f) => f.label).join('; ') || 'none'}`);
  let out;
  try { const s = String(text); out = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { throw fail('The AI answer could not be read. Try again.', 502); }
  r.aiCheck = { verdict: ['ok', 'suspicious', 'remove'].includes(out.verdict) ? out.verdict : 'suspicious', reason: clip(out.reason, 500), at: new Date() };
  await r.save();
  return r.aiCheck;
}

// ---------------------------------------------------------------- Trust Score (12.15)

const median = (list) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function trustScore(employerId) {
  const [verified, user, reviews, employments, jobsCount, cases, complaints] = await Promise.all([
    isRoleVerified(employerId, 'employer'),
    User.findById(employerId).select('employerSanctions').lean(),
    CompanyReview.find({ employer: employerId, status: 'published' }).select('rating salaryOnTime').lean(),
    Employment.find({ employer: employerId, application: { $ne: null } }).select('application createdAt').populate('application', 'createdAt').lean(),
    Job.countDocuments({ postedBy: employerId, institution: null }),
    EmployerFraudCase.find({ employer: employerId, status: { $in: ['open', 'actioned'] } }).select('status').lean(),
    require('../models/Complaint').countDocuments({ targetType: 'user', targetId: employerId, status: { $ne: 'dismissed' } })
  ]);
  const sanction = user?.employerSanctions?.level || 'none';
  const days = employments.filter((e) => e.application?.createdAt).map((e) => (new Date(e.createdAt) - new Date(e.application.createdAt)) / 864e5);
  const hireDays = median(days);
  const salaryAnswers = reviews.filter((r) => r.salaryOnTime !== null && r.salaryOnTime !== undefined)
    .concat((await require('./employerPayroll.service').onTimeRecord(employerId)).map((onTime) => ({ salaryOnTime: onTime })));
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
  const problems = cases.length + complaints;
  const ratio = jobsCount ? problems / jobsCount : problems ? 1 : 0;
  const factors = [
    { key: 'verified', label: 'Verified Employer', max: 20, points: verified ? 20 : 0, value: verified ? 'Verified by CareerZ' : 'Not verified', hasData: true },
    { key: 'fastHiring', label: 'Fast Hiring', max: 15, hasData: hireDays !== null, points: hireDays === null ? 0 : hireDays <= 14 ? 15 : hireDays <= 30 ? 10 : hireDays <= 60 ? 5 : 2, value: hireDays === null ? 'No hires yet' : `Offers in about ${Math.round(hireDays)} day${Math.round(hireDays) === 1 ? '' : 's'}` },
    { key: 'onTimeSalary', label: 'On-time Salary', max: 15, hasData: salaryAnswers.length > 0, points: salaryAnswers.length ? Math.round(15 * salaryAnswers.filter((r) => r.salaryOnTime).length / salaryAnswers.length) : 0, value: salaryAnswers.length ? `${Math.round(100 * salaryAnswers.filter((r) => r.salaryOnTime).length / salaryAnswers.length)}% of employees say salary comes on time` : 'No answers yet' },
    { key: 'satisfaction', label: 'Employee Satisfaction', max: 20, hasData: avgRating !== null, points: avgRating === null ? 0 : Math.round(20 * avgRating / 5), value: avgRating === null ? 'No reviews yet' : `${avgRating.toFixed(1)} / 5 from ${reviews.length} review${reviews.length === 1 ? '' : 's'}` },
    { key: 'complaints', label: 'Complaint Ratio', max: 15, hasData: true, points: Math.round(15 * Math.max(0, 1 - ratio * 5)), value: problems ? `${problems} complaint${problems === 1 ? '' : 's'} for ${jobsCount} job${jobsCount === 1 ? '' : 's'}` : 'No complaints' },
    { key: 'scamFree', label: 'Scam-Free', max: 15, hasData: true, points: sanction === 'none' && !cases.some((c) => c.status === 'actioned') ? 15 : sanction === 'warning' ? 7 : 0, value: sanction === 'none' ? 'No fraud action' : sanction === 'warning' ? 'Has a CareerZ warning' : sanction === 'suspended' ? 'Suspended by CareerZ' : 'Banned by CareerZ' }
  ];
  // Factors without data yet are left out, so a new employer is not marked down for being new.
  const counted = factors.filter((f) => f.hasData);
  const max = counted.reduce((s, f) => s + f.max, 0);
  const score = max ? Math.round(100 * counted.reduce((s, f) => s + f.points, 0) / max) : 0;
  return { score, level: score >= 80 ? 'High' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Low', factors, reviewCount: reviews.length, averageRating: avgRating === null ? null : Number(avgRating.toFixed(1)), sanction };
}

// Public: the company's trust score and published reviews (shown to job seekers).
async function publicProfile(employerId) {
  if (!oid(employerId)) throw fail('Company not found.', 404);
  const employer = await User.findOne({ _id: employerId, roles: 'employer' }).select('fullName').lean();
  if (!employer) throw fail('Company not found.', 404);
  const reviews = await CompanyReview.find({ employer: employerId, status: 'published' })
    .populate({ path: 'employment', select: 'job', populate: { path: 'job', select: 'title' } }).sort({ createdAt: -1 }).limit(30).lean();
  return { employer: { _id: employer._id, fullName: employer.fullName }, trust: await trustScore(employerId), reviews: reviews.map(publicShape) };
}

// ---------------------------------------------------------------- Fraud protection (12.17)

const FRAUD_CATEGORIES = { fake_job: 'Fake job', salary_scam: 'Salary scam', fake_interview: 'Fake interview', illegal_recruitment: 'Illegal recruitment', identity_fraud: 'Identity fraud' };

async function reportFraud(user, employerId, body = {}) {
  if (!oid(employerId)) throw fail('Company not found.', 404);
  if (String(employerId) === String(user._id)) throw fail('You cannot report your own company.');
  const employer = await User.findOne({ _id: employerId, roles: 'employer' }).select('fullName');
  if (!employer) throw fail('Company not found.', 404);
  if (!FRAUD_CATEGORIES[body.category]) throw fail('Choose what kind of fraud this is.');
  const description = clip(body.description, 3000);
  if (description.length < 20) throw fail('Describe what happened in a few lines.');
  if (await EmployerFraudCase.exists({ employer: employerId, reportedBy: user._id, status: 'open' })) throw fail('You already have an open report on this company. Add evidence to it instead.', 409);
  let job = null;
  if (body.job) { if (!oid(body.job) || !(await Job.exists({ _id: body.job, postedBy: employerId }))) throw fail('That job is not from this company.'); job = body.job; }
  const evidence = clip(body.evidence, 2000);
  const c = await EmployerFraudCase.create({ employer: employerId, reportedBy: user._id, category: body.category, job, description, evidence: evidence ? [{ note: evidence, by: user._id }] : [] });
  await notifyAdmins({ title: `Fraud report: ${FRAUD_CATEGORIES[body.category]} — ${employer.fullName}`, body: description.slice(0, 200) }).catch(() => {});
  return c;
}

async function myFraudReports(user) {
  return EmployerFraudCase.find({ reportedBy: user._id }).populate('employer', 'fullName').populate('job', 'title').select('-authorityReport').sort({ createdAt: -1 }).lean();
}

// Evidence is append-only: the reporter or an admin adds to it, nobody removes it.
async function addEvidence(user, id, note, isAdmin = false) {
  if (!oid(id)) throw fail('Report not found.', 404);
  const c = await EmployerFraudCase.findById(id);
  if (!c || (!isAdmin && String(c.reportedBy) !== String(user._id))) throw fail('Report not found.', 404);
  const text = clip(note, 2000);
  if (text.length < 5) throw fail('Write the evidence.');
  c.evidence.push({ note: text, by: user._id });
  await c.save();
  return c;
}

const NEXT = { none: 'warning', warning: 'suspension', suspended: 'ban', banned: 'ban' };

async function adminCases({ status = 'open', employer } = {}) {
  const filter = {};
  if (status === 'archive') filter.archivedAt = { $ne: null };
  else if (status) filter.status = status;
  if (employer && oid(employer)) filter.employer = employer;
  return EmployerFraudCase.find(filter).populate('employer', 'fullName email employerSanctions').populate('reportedBy', 'fullName email').populate('job', 'title status').populate('evidence.by', 'fullName').sort({ createdAt: -1 }).limit(200).lean();
}

// Admin decision on the ladder. action: dismiss | warning | suspension | ban | next.
async function adminDecideCase(admin, id, { action, days, note }) {
  if (!oid(id)) throw fail('Report not found.', 404);
  const c = await EmployerFraudCase.findById(id);
  if (!c) throw fail('Report not found.', 404);
  if (c.status !== 'open') throw fail('This report is already decided.', 409);
  const text = clip(note, 1000);
  if (!text) throw fail('Write the reason; it is kept with the evidence.');
  const employer = await User.findById(c.employer);
  const current = employer.employerSanctions?.level || 'none';
  const step = action === 'next' ? NEXT[current] : action;
  if (!['dismiss', 'warning', 'suspension', 'ban'].includes(step)) throw fail('Choose dismiss, warning, suspension or ban.');
  Object.assign(c, { decidedBy: admin._id, decidedAt: new Date(), decisionNote: text, archivedAt: new Date() });
  if (step === 'dismiss') {
    c.status = 'dismissed';
    await c.save();
    if (c.reportedBy) await notify(c.reportedBy, { title: 'Your fraud report was reviewed', body: `CareerZ found no fraud: ${text}`, category: 'employer_fraud' }).catch(() => {});
    return c;
  }
  c.status = 'actioned';
  c.action = step;
  const s = employer.employerSanctions || {};
  if (step === 'warning') {
    employer.employerSanctions = { ...s, level: current === 'none' ? 'warning' : current, warnings: (s.warnings || 0) + 1, reason: text };
    await notify(employer._id, { title: 'Warning from CareerZ', body: `${FRAUD_CATEGORIES[c.category]}: ${text}. Another violation can suspend your account.` }, { email: true }).catch(() => {});
  } else if (step === 'suspension') {
    const n = Number(days) || 30;
    if (!Number.isInteger(n) || n < 1 || n > 365) throw fail('Suspension must be 1 to 365 days.');
    c.suspendedUntil = new Date(Date.now() + n * 864e5);
    employer.employerSanctions = { ...s, level: 'suspended', suspendedUntil: c.suspendedUntil, reason: text };
    await Job.updateMany({ postedBy: employer._id, institution: null, status: 'active' }, { $set: { status: 'paused' } });
    await notify(employer._id, { title: 'Your employer account is suspended', body: `${text}. Until ${c.suspendedUntil.toDateString()}. Your live jobs are paused.` }, { email: true }).catch(() => {});
  } else {
    employer.employerSanctions = { ...s, level: 'banned', bannedAt: new Date(), reason: text };
    employer.roles = (employer.roles || []).filter((r) => r !== 'employer');
    await RoleRequest.updateMany({ user: employer._id, requestedRole: 'employer', status: 'approved' }, { $set: { status: 'suspended', reviewNotes: `Banned: ${text}` } });
    await Job.updateMany({ postedBy: employer._id, institution: null, status: { $in: ['active', 'paused', 'pending_review', 'draft'] } }, { $set: { status: 'closed' } });
    await EmployerFraudCase.updateMany({ employer: employer._id, archivedAt: null }, { $set: { archivedAt: new Date() } });
    await require('../models/EmployerStaff').updateMany({ employer: employer._id, status: { $in: ['invited', 'active'] } }, { $set: { status: 'removed', removedAt: new Date() } });
    await notify(employer._id, { title: 'Your employer account is permanently banned', body: text }, { email: true }).catch(() => {});
  }
  employer.markModified('employerSanctions');
  await employer.save();
  await c.save();
  if (c.reportedBy) await notify(c.reportedBy, { title: 'Action taken on your fraud report', body: `CareerZ gave the company a ${step === 'ban' ? 'permanent ban' : step}.`, category: 'employer_fraud' }).catch(() => {});
  return c;
}

// Recorded only when the law allows it and evidence is on file; CareerZ does not send it itself.
async function adminAuthorityReport(admin, id, { authority, note, lawAllows }) {
  if (!oid(id)) throw fail('Report not found.', 404);
  const c = await EmployerFraudCase.findById(id);
  if (!c) throw fail('Report not found.', 404);
  if (c.status !== 'actioned') throw fail('Only a case with action taken can be reported to an authority.', 409);
  if (!c.evidence.length) throw fail('Add evidence to the case first.', 409);
  if (lawAllows !== true) throw fail('Confirm the law allows this report.');
  const a = clip(authority, 200);
  if (!a) throw fail('Name the authority.');
  c.authorityReport = { authority: a, note: clip(note, 1000), at: new Date(), by: admin._id };
  await c.save();
  return c;
}

// Lift a suspension early, or clear a warning.
async function adminLift(admin, employerId, note) {
  if (!oid(employerId)) throw fail('Employer not found.', 404);
  const u = await User.findById(employerId);
  if (!u) throw fail('Employer not found.', 404);
  if (u.employerSanctions?.level === 'banned') throw fail('A permanent ban cannot be lifted here.', 409);
  u.employerSanctions = { ...(u.employerSanctions || {}), level: 'none', suspendedUntil: null, reason: clip(note, 300) };
  u.markModified('employerSanctions');
  await u.save();
  await notify(u._id, { title: 'CareerZ lifted the restriction on your employer account', body: clip(note, 300) }).catch(() => {});
  return u.employerSanctions;
}

// Posting gate for an employer's own jobs and for staff posting in the employer's name.
async function assertEmployerMayPost(employerId) {
  const u = await User.findById(employerId).select('employerSanctions').lean();
  const s = u?.employerSanctions;
  if (s?.level === 'banned') throw fail('This employer account is banned from CareerZ.', 403);
  if (s?.level === 'suspended' && s.suspendedUntil && new Date(s.suspendedUntil) > new Date()) throw fail(`This employer account is suspended until ${new Date(s.suspendedUntil).toDateString()}. Reason: ${s.reason || 'CareerZ review'}.`, 403);
}

module.exports = {
  reviewable, createReview, myReviews, employerReviews, respond, report, appeal, adminQueue, adminDecide, adminDecideAppeal, adminAiCheck,
  trustScore, publicProfile, FRAUD_CATEGORIES, reportFraud, myFraudReports, addEvidence, adminCases, adminDecideCase, adminAuthorityReport, adminLift, assertEmployerMayPost
};

// ---------------------------------------------------------------- Super Admin employers panel (12.20)

async function adminOverview() {
  const employerIds = await RoleRequest.distinct('user', { requestedRole: 'employer', status: 'approved' });
  const [bySubtype, pendingVerification, activeJobs, filledJobs, openFraud, actionedFraud, reviewsWaiting, sanctioned, byCountry] = await Promise.all([
    RoleRequest.aggregate([{ $match: { requestedRole: 'employer', status: 'approved' } }, { $group: { _id: '$subtype', n: { $sum: 1 } } }]),
    RoleRequest.countDocuments({ requestedRole: 'employer', status: 'pending' }),
    Job.countDocuments({ postedBy: { $in: employerIds }, institution: null, status: 'active' }),
    Job.countDocuments({ postedBy: { $in: employerIds }, institution: null, status: 'filled' }),
    EmployerFraudCase.countDocuments({ status: 'open' }),
    EmployerFraudCase.countDocuments({ status: 'actioned' }),
    CompanyReview.countDocuments({ $or: [{ status: 'pending' }, { 'report.open': true }, { 'appeal.status': 'pending' }] }),
    User.aggregate([{ $match: { 'employerSanctions.level': { $in: ['warning', 'suspended', 'banned'] } } }, { $group: { _id: '$employerSanctions.level', n: { $sum: 1 } } }]),
    Job.aggregate([{ $match: { postedBy: { $in: employerIds }, institution: null } }, { $group: { _id: '$country', jobs: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }, { $sort: { jobs: -1 } }, { $limit: 15 }])
  ]);
  return {
    totalEmployers: employerIds.length,
    companies: Object.fromEntries(bySubtype.map((s) => [s._id || 'other', s.n])),
    pendingVerification, activeJobs, filledJobs, openFraud, actionedFraud, reviewsWaiting,
    sanctions: Object.fromEntries(sanctioned.map((s) => [s._id, s.n])),
    byCountry: byCountry.map((c) => ({ country: c._id || '—', jobs: c.jobs, active: c.active }))
  };
}

async function adminEmployers({ q = '' } = {}) {
  const ids = await RoleRequest.distinct('user', { requestedRole: 'employer', status: { $in: ['approved', 'suspended'] } });
  const filter = { _id: { $in: ids } };
  const text = String(q).trim().slice(0, 80);
  if (text) { const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ fullName: re }, { email: re }]; }
  const users = await User.find(filter).select('fullName email country employerSanctions createdAt').sort({ createdAt: -1 }).limit(100).lean();
  const uid = users.map((u) => u._id);
  const [jobs, cases] = await Promise.all([
    Job.aggregate([{ $match: { postedBy: { $in: uid }, institution: null } }, { $group: { _id: '$postedBy', total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, filled: { $sum: { $cond: [{ $eq: ['$status', 'filled'] }, 1, 0] } } } }]),
    EmployerFraudCase.aggregate([{ $match: { employer: { $in: uid }, status: 'open' } }, { $group: { _id: '$employer', n: { $sum: 1 } } }])
  ]);
  const J = Object.fromEntries(jobs.map((j) => [String(j._id), j])), C = Object.fromEntries(cases.map((c) => [String(c._id), c.n]));
  return Promise.all(users.map(async (u) => ({ ...u, jobs: J[String(u._id)] || { total: 0, active: 0, filled: 0 }, openFraud: C[String(u._id)] || 0, trust: (await trustScore(u._id)).score })));
}

module.exports.adminOverview = adminOverview;
module.exports.adminEmployers = adminEmployers;
