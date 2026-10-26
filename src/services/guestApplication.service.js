const crypto = require('crypto');
const mongoose = require('mongoose');
const Job = require('../models/Job');
const User = require('../models/User');
const Setting = require('../models/Setting');
const Commission = require('../models/Commission');
const PrivateFile = require('../models/PrivateFile');
const GuestApplication = require('../models/GuestApplication');
const AppError = require('../utils/AppError');
const { siteUrl } = require('../utils/siteUrl');
const { notify, escapeHtml } = require('./notification.service');
const jobAccess = require('./jobAccess.service');

// Guest job applications: apply with a CV and an email, no account. One emailed tracking link
// both proves the address and shows the status; the hiring side sees the application only after
// the link was opened. Unverified applications go after UNVERIFIED_HOURS, the rest (CV included)
// RETENTION_DAYS after their last change.

const UNVERIFIED_HOURS = 72;
const RETENTION_DAYS = Number(process.env.GUEST_RETENTION_DAYS) || 180;
const STAGE_LABEL = { pending: 'Applied', viewed: 'Screening', shortlisted: 'Shortlisted', interview: 'Interview', final_interview: 'Final interview', selected: 'Offer', accepted: 'Offer accepted', hired: 'Joined', completed: 'Completed', rejected: 'Not selected', withdrawn: 'Withdrawn' };
const STATUSES = Object.keys(STAGE_LABEL);
const CV_TYPES = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
const fail = (m, c = 422) => new AppError(m, c);
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function trackUrl(token) { return `${siteUrl()}/application-status?token=${token}`; }
// Sign-up link with the guest's email filled in; teaching jobs open the Teacher account type.
function signupUrl(a, job) { return `${siteUrl()}/signup?type=${job?.category === 'teaching' ? 'teacher' : 'student'}&email=${encodeURIComponent(a.email)}&name=${encodeURIComponent(a.name)}`; }
const ACCOUNT_STAGES = ['selected', 'accepted', 'hired', 'completed'];
// The guest's path to a full account, shown in every guest email (guests only).
function stepsHtml(a, job, { confirmed = false } = {}) {
  const kind = job?.category === 'teaching' ? 'Teacher' : 'Student';
  const li = (s) => `<li style="margin:0 0 6px">${s}</li>`;
  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:14px 0"><p style="margin:0 0 8px"><b>How to follow your application on CareerZ</b></p><ol style="margin:0;padding-left:20px">`
    + (confirmed ? '' : li(`<b>Confirm</b> this application with the button above.`))
    + li(`<b>Create your free CareerZ ${kind} account</b> with this same email (${escapeHtml(a.email)}): <a href="${signupUrl(a, job)}">create my account</a>.`)
    + li('<b>Verify your email</b> with the code we send you.')
    + li('<b>Upload your verification documents</b> (CNIC and the documents the form asks for) and submit them.')
    + li('<b>Wait for the CareerZ admin team to verify your account.</b> You get an email when it is approved.')
    + li('<b>Complete your profile</b>, then open your dashboard.')
    + li('Go to <b>Jobs &amp; Applications → My Applications</b> to see your application status, offers and messages. This application moves into your account by itself.')
    + '</ol></div>';
}
async function sendEmail(to, subject, html) {
  const { sendEmail: send } = require('./email.service');
  return send({ to, subject, html }).catch((e) => console.error('[guest] email failed:', e.message));
}
const button = (url, label) => `<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${label}</a></p><p style="color:#666;font-size:12px">Or open: ${url}</p>`;

async function apply(job, body = {}, ip = '') {
  if (body.website) return { honeypot: true }; // bots fill the hidden field; pretend success
  if (!job || job.status !== 'active' || !(await require('./publicListings.service').jobDetail(job._id))) throw fail('This job is no longer accepting applications.', 400);
  if (job.applicationDeadline && new Date(job.applicationDeadline) < new Date()) throw fail('The application deadline has passed.', 400);
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase();
  if (name.length < 2) throw fail('Enter your full name.');
  const phone = String(body.phone || '').trim();
  if (!/^\+?[0-9][0-9\s-]{6,18}$/.test(phone)) throw fail('Enter your phone number, e.g. 03001234567.');
  if (!EMAIL.test(email) || email.length > 160) throw fail('Enter a valid email address.');
  if (body.consent !== true) throw fail('Agree to share your details with the hiring organization.');
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.cv?.data || ''));
  if (!m || !CV_TYPES[m[1]]) throw fail('Attach your CV as a PDF or Word file.');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 2 * 1024 * 1024) throw fail('The CV must be 2 MB or smaller.');
  if (await GuestApplication.exists({ job: job._id, email, status: { $ne: 'withdrawn' } })) throw fail('An application with this email already exists for this job. Use the link in your email to track it.', 409);
  const today = await GuestApplication.countDocuments({ email, createdAt: { $gte: new Date(Date.now() - 864e5) } });
  if (today >= 10) throw fail('Too many applications from this email today. Try again tomorrow.', 429);

  const cv = await PrivateFile.create({ purpose: 'guest_cv', filename: String(body.cv.name || `cv.${CV_TYPES[m[1]]}`).slice(0, 160), mimeType: m[1], size: data.length, data });
  const token = crypto.randomBytes(24).toString('hex');
  const application = await GuestApplication.create({
    job: job._id, name, email, phone: phone.slice(0, 40), city: String(body.city || '').slice(0, 80), coverLetter: String(body.coverLetter || '').slice(0, 4000),
    cv: cv._id, trackingTokenHash: hash(token), consentAt: new Date(), ip: String(ip).slice(0, 64), statusHistory: [{ status: 'pending', byRole: 'applicant' }]
  });
  await sendEmail(email, `Confirm your application: ${job.title}`,
    `<p>Hi ${escapeHtml(name)},</p><p>To send your application for <b>${escapeHtml(job.title)}</b> at ${escapeHtml(job.company)}, confirm your email. The same link shows your application status later, so keep this email.</p>${button(trackUrl(token), 'Confirm and track my application')}${stepsHtml({ name, email }, job)}<p>If you did not apply, ignore this email; the application is deleted in ${UNVERIFIED_HOURS} hours.</p>`);
  return { application, token };
}

async function byToken(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) throw fail('This link is not valid.', 404);
  const application = await GuestApplication.findOne({ trackingTokenHash: hash(token) }).populate('job', 'title company city country postedBy institution agreement status category');
  if (!application) throw fail('This application was not found. It may have been deleted after the retention period.', 404);
  return application;
}
function view(a) {
  return { _id: a._id, name: a.name, job: a.job ? { _id: a.job._id, title: a.job.title, company: a.job.company, city: a.job.city, country: a.job.country } : null, status: a.status, stage: STAGE_LABEL[a.status],
    history: a.statusHistory.map((h) => ({ status: h.status, stage: STAGE_LABEL[h.status], at: h.at, note: h.note || '' })), submittedAt: a.createdAt,
    signupUrl: signupUrl(a, a.job), accountType: a.job?.category === 'teaching' ? 'teacher' : 'student',
    canWithdraw: !['hired', 'completed', 'rejected', 'withdrawn'].includes(a.status), canConfirmJoining: a.status === 'hired' && !a.joining.confirmed && !a.job?.agreement && a.joining.via !== 'hiring_organization' };
}
// Opening the link: first time it verifies the email and the application reaches the employer.
async function track(token) {
  const a = await byToken(token);
  if (!a.emailVerified) {
    a.emailVerified = true; a.verifiedAt = new Date();
    await a.save();
    if (a.job) await notify(a.job.postedBy, { title: `New application (guest): ${a.job.title}`, body: `${a.name} applied without an account.`, link: require('../utils/dashLinks').manager(a.job), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  }
  return view(a);
}
async function withdraw(token, reason) {
  const a = await byToken(token);
  if (!view(a).canWithdraw) throw fail(`This application is already ${STAGE_LABEL[a.status].toLowerCase()}.`, 409);
  a.status = 'withdrawn';
  a.statusHistory.push({ status: 'withdrawn', byRole: 'applicant', note: String(reason || '').slice(0, 300) });
  await a.save();
  if (a.emailVerified && a.job) await notify(a.job.postedBy, { title: `Application withdrawn: ${a.job.title}`, body: `${a.name} (guest) withdrew.`, link: require('../utils/dashLinks').manager(a.job), category: 'application' }).catch(() => {});
  return view(a);
}
// Existing Agent commission rule for an agent's own job (Master 13), as for registered candidates.
async function agentCommission(a, job) {
  if (job.institution || job.agreement || await Commission.exists({ guestApplication: a._id })) return;
  const poster = await User.findById(job.postedBy).select('roles');
  if (!poster?.roles?.includes('education_agent') || (poster.roles.includes('employer') && await require('../utils/roleVerification').isRoleVerified(poster._id, 'employer'))) return;
  const full = await Job.findById(job._id).select('salaryMin salaryMax currency title representedEmployer employerConsent');
  const agentWork = require('./agentWork.service');
  const due = await agentWork.commissionFor(full, full.salaryMin || full.salaryMax || 0);
  if (!due) return; // no employer on CareerZ accepted this job, so nobody owes a commission
  const c = await Commission.create({ agent: job.postedBy, employer: due.employer, job: job._id, guestApplication: a._id, candidateName: a.name, rate: due.rate, amount: due.amount, currency: full.currency || 'PKR' });
  await agentWork.tellEmployerToPay(c, full.title);
  await notify(job.postedBy, { title: `Commission generated: ${c.currency} ${c.amount}`, body: `${full.title}: joining confirmed.`, link: require('../utils/dashLinks').agentCommission, category: 'commission' }).catch(() => {});
}
async function confirmJoining(token) {
  const a = await byToken(token);
  if (!view(a).canConfirmJoining) throw fail('There is no joining for you to confirm.', 409);
  a.joining = { confirmed: true, confirmedBy: null, confirmedAt: new Date(), via: 'candidate' };
  a.statusHistory.push({ status: 'hired', byRole: 'applicant', note: 'Candidate confirmed joining' });
  await a.save();
  if (a.job.status !== 'filled') await Job.updateOne({ _id: a.job._id }, { status: 'filled' });
  await agentCommission(a, a.job);
  await notify(a.job.postedBy, { title: `Joining confirmed: ${a.job.title}`, body: `${a.name} confirmed they joined.`, link: require('../utils/dashLinks').manager(a.job), category: 'application' }).catch(() => {});
  return view(a);
}

// ---------------------------------------------------------------- hiring side
async function forManager(user, jobId) {
  if (!mongoose.isValidObjectId(jobId)) throw fail('Job not found.', 404);
  const job = await Job.findById(jobId);
  if (!job) throw fail('Job not found.', 404);
  await jobAccess.assertCanManageJob(job, user);
  const list = await GuestApplication.find({ job: job._id, emailVerified: true }).select('-trackingTokenHash -ip').sort({ createdAt: -1 }).lean();
  const pending = list.filter((a) => a.status === 'pending');
  if (pending.length) {
    await GuestApplication.updateMany({ _id: { $in: pending.map((a) => a._id) } }, { $set: { status: 'viewed' }, $push: { statusHistory: { status: 'viewed', at: new Date(), byRole: 'system' } } });
    pending.forEach((a) => { a.status = 'viewed'; });
  }
  return list.map((a) => ({ ...a, guest: true, stage: STAGE_LABEL[a.status] }));
}
async function managed(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Application not found.', 404);
  const a = await GuestApplication.findById(id).populate('job');
  if (!a || !a.emailVerified) throw fail('Application not found.', 404);
  await jobAccess.assertCanManageJob(a.job, user);
  return a;
}
async function updateStatus(user, id, { status, note }) {
  if (!STATUSES.includes(status)) throw fail('Invalid status.');
  const a = await managed(user, id);
  const job = a.job;
  // An offer and joining need a CareerZ account: invite the guest to sign up with this email.
  // Their application then moves into the account and continues there.
  if (ACCOUNT_STAGES.includes(status)) {
    await sendEmail(a.email, `Next step for ${job.title}: create your CareerZ account`,
      `<p>Hi ${escapeHtml(a.name)},</p><p>Good news: ${escapeHtml(job.company)} wants to move forward with your application for <b>${escapeHtml(job.title)}</b>.</p><p>To receive the offer and join, create your free CareerZ account with this same email (${escapeHtml(a.email)}). Your application moves into your account automatically.</p>${button(signupUrl(a, job), 'Create my CareerZ account')}${stepsHtml(a, job, { confirmed: true })}`);
    throw fail(`${a.name} applied without an account. We emailed them a link to create a CareerZ account with ${a.email}; once they do, the application moves to their account and you can continue from Offer.`, 409);
  }
  const { isHiringOrganization } = require('../controllers/job.controller');
  const hiringOrg = await isHiringOrganization(job, user);
  const text = String(note || '').trim().slice(0, 500);
  const previous = a.status;
  a.status = status;
  a.statusHistory.push({ status, by: user._id, byRole: hiringOrg ? 'hiring_organization' : 'agent', note: text });
  if (status === 'hired' && previous !== 'hired') a.joining = hiringOrg ? { confirmed: true, confirmedBy: user._id, confirmedAt: new Date(), via: 'hiring_organization' } : { confirmed: false, confirmedBy: null, confirmedAt: null, via: '' };
  if (previous === 'hired' && !['hired', 'completed'].includes(status)) a.joining = { confirmed: false, confirmedBy: null, confirmedAt: null, via: '' };
  await a.save();
  if (['hired', 'completed'].includes(previous) && !['hired', 'completed'].includes(status)) await Commission.updateOne({ guestApplication: a._id, status: { $ne: 'paid' } }, { status: 'cancelled' });
  if (status === 'hired' && a.joining.confirmed && job.status !== 'filled') { job.status = 'filled'; await job.save(); }
  if (status === 'hired' && !a.joining.confirmed && job.agreement) {
    const { tellInstitution } = require('./recruitment.service');
    await tellInstitution(job.institution, { title: `Confirm joining: ${job.title}`, body: 'Your recruitment agent marked a candidate as joined. Confirm or decline in Jobs & Hiring → Agents.', link: '/dashboard', sentBy: user._id });
  }
  // The guest has no account: the update goes by email, with the tracking link's page.
  const asksConfirm = status === 'hired' && !a.joining.confirmed && !job.agreement;
  await sendEmail(a.email, `${job.title} @ ${job.company}: ${STAGE_LABEL[status]}`,
    `<p>Hi ${escapeHtml(a.name)},</p><p>Your application for <b>${escapeHtml(job.title)}</b> is now at: <b>${STAGE_LABEL[status]}</b>.</p>${text ? `<p>${escapeHtml(text)}</p>` : ''}${asksConfirm ? '<p>Please confirm that you have joined, using the link in your first email from us.</p>' : ''}<p>Open the tracking link from your first email to see the full status.</p>${status !== 'rejected' ? `<p>Create your free CareerZ account with this email now; you will need it to receive an offer.</p>${stepsHtml(a, job, { confirmed: true })}` : ''}`);
  return a;
}
async function cvFile(user, id) {
  const a = await managed(user, id);
  return PrivateFile.findById(a.cv);
}

// ---------------------------------------------------------------- retention
async function cleanup(now = new Date()) {
  const stale = await GuestApplication.find({ $or: [
    { emailVerified: false, createdAt: { $lt: new Date(now - UNVERIFIED_HOURS * 36e5) } },
    { updatedAt: { $lt: new Date(now - RETENTION_DAYS * 864e5) } }
  ] }).select('cv').lean();
  if (!stale.length) return 0;
  await PrivateFile.deleteMany({ _id: { $in: stale.map((a) => a.cv) } });
  await GuestApplication.deleteMany({ _id: { $in: stale.map((a) => a._id) } });
  return stale.length;
}
let timer = null;
function startGuestCleanup() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => cleanup().catch((e) => console.error('[guest] cleanup failed:', e.message)), 6 * 36e5);
  timer.unref?.();
}

module.exports = { apply, track, withdraw, confirmJoining, forManager, updateStatus, cvFile, cleanup, startGuestCleanup, byToken, STAGE_LABEL, RETENTION_DAYS, UNVERIFIED_HOURS };
