const mongoose = require('mongoose');
const crypto = require('crypto');
const Setting = require('../models/Setting');
const Job = require('../models/Job');
const User = require('../models/User');
const EmployerPurchase = require('../models/EmployerPurchase');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');

const fail = (message, status = 422) => new AppError(message, status);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const KEY = 'employer_packages';

// Master 12.18 packages. Super Admin sets every price, length and limit (12.20); these are only
// the starting values. Featured Job keeps its own fee and checkout (Jobs → Feature).
const DEFAULTS = {
  currency: 'PKR',
  taxPercent: 0,
  freeActiveJobs: 0, // 0 = no limit on live jobs without a subscription
  packages: {
    sponsored: { label: 'Sponsored Job', perJob: true, price: 1500, days: 7, about: 'Shown above normal jobs in search, marked Sponsored.' },
    urgent: { label: 'Urgent Job', perJob: true, price: 1000, days: 7, about: 'An "Urgent hiring" badge on the job.' },
    top_hiring: { label: 'Top Hiring Employer', perJob: false, price: 3000, days: 30, about: 'A Top Hiring badge on all your jobs and your company page.' },
    subscription: { label: 'Employer Subscription', perJob: false, price: 5000, days: 30, jobLimit: 25, about: 'Keep more jobs live at once.' },
    hiring_package: { label: 'Hiring Package', perJob: false, price: 8000, days: 0, credits: 5, about: 'Featured Job credits to use on any of your jobs.' },
    premium_tools: { label: 'Premium Recruitment Tools', perJob: false, price: 2500, days: 30, about: 'Download applicant lists as a spreadsheet (CSV) for every job.' }
  }
};

async function config() {
  const s = await Setting.findOne({ key: KEY }).lean();
  const v = s?.value || {};
  const packages = {};
  for (const [k, d] of Object.entries(DEFAULTS.packages)) packages[k] = { ...d, ...(v.packages?.[k] || {}), key: k };
  return { currency: DEFAULTS.currency, taxPercent: v.taxPercent ?? DEFAULTS.taxPercent, freeActiveJobs: v.freeActiveJobs ?? DEFAULTS.freeActiveJobs, packages };
}

// Super Admin: prices, lengths, tax and the free live-job limit.
async function setConfig(admin, body = {}) {
  if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin can change package prices.', 403);
  const cur = await config();
  const num = (v, min, max, label) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw fail(`${label} must be from ${min} to ${max}.`); return n; };
  const next = { taxPercent: body.taxPercent !== undefined ? num(body.taxPercent, 0, 50, 'Tax') : cur.taxPercent, freeActiveJobs: body.freeActiveJobs !== undefined ? Math.round(num(body.freeActiveJobs, 0, 1000, 'Free live jobs')) : cur.freeActiveJobs, packages: {} };
  for (const [k, p] of Object.entries(cur.packages)) {
    const b = body.packages?.[k] || {};
    next.packages[k] = {
      price: b.price !== undefined ? round2(num(b.price, 0, 10000000, `${p.label} price`)) : p.price,
      days: b.days !== undefined ? Math.round(num(b.days, k === 'hiring_package' ? 0 : 1, 365, `${p.label} days`)) : p.days,
      ...(k === 'subscription' ? { jobLimit: b.jobLimit !== undefined ? Math.round(num(b.jobLimit, 1, 1000, 'Subscription job limit')) : p.jobLimit } : {}),
      ...(k === 'hiring_package' ? { credits: b.credits !== undefined ? Math.round(num(b.credits, 1, 100, 'Featured credits')) : p.credits } : {})
    };
  }
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next, updatedBy: admin._id } }, { upsert: true });
  return config();
}

// Who the purchase is for: the employer, or a company the user pays for as staff (manage_payments).
async function employerFor(user, employerId) {
  if (employerId && String(employerId) !== String(user._id)) {
    await require('./employerStaff.service').assertPermission(user._id, employerId, 'manage_payments');
    return employerId;
  }
  if (!(await isRoleVerified(user._id, 'employer'))) throw fail('Only a verified employer can buy employer packages.', 403);
  return user._id;
}

// ManualPayment resolver for kind 'employer_package' (CareerZ is the seller).
async function resolve(user, key, body = {}) {
  const cfg = await config();
  const p = cfg.packages[key];
  if (!p) throw fail('Package not found.', 404);
  if (!(p.price > 0)) throw fail('This package has no price yet.', 503);
  const employer = await employerFor(user, body.employer);
  await require('./employerTrust.service').assertEmployerMayPost(employer);
  let job = null;
  if (p.perJob) {
    if (!mongoose.isValidObjectId(body.job)) throw fail('Choose the job to promote.');
    job = await Job.findOne({ _id: body.job, postedBy: employer, institution: null, status: { $in: ['active', 'paused'] } }).select('title');
    if (!job) throw fail('Choose one of the company\'s live or paused jobs.', 404);
  }
  const tax = round2(p.price * (cfg.taxPercent || 0) / 100);
  return {
    title: `${p.label}${p.days ? ` (${p.days} days)` : ''}${job ? `: ${job.title}` : ''}`,
    price: round2(p.price + tax), currency: cfg.currency, recipient: null,
    refs: { plan: key, job: job?._id || null, employerAccount: employer },
    openSuffix: `${key}:${job?._id || employer}`
  };
}

const later = (current, days) => new Date(Math.max(Date.now(), current ? new Date(current).getTime() : 0) + days * 864e5);

// Granted when CareerZ approves the receipt (inside the approval transaction).
async function grant(mp, session) {
  const cfg = await config();
  const p = cfg.packages[mp.plan];
  if (!p) throw fail('Package not found.', 404);
  const employerId = mp.employerAccount || mp.payer;
  const base = round2(mp.price / (1 + (cfg.taxPercent || 0) / 100));
  const purchase = {
    invoiceNumber: `INV-EMP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
    employer: employerId, boughtBy: mp.payer, package: mp.plan, title: mp.title, job: mp.job || null, currency: mp.currency,
    baseAmount: base, taxPercent: cfg.taxPercent || 0, taxAmount: round2(mp.price - base), amount: mp.price, days: p.days || 0, credits: p.credits || 0,
    manualPayment: mp._id, paymentRef: mp.number
  };
  if (p.perJob) {
    const job = await Job.findById(mp.job).session(session);
    const field = mp.plan === 'sponsored' ? 'sponsoredUntil' : 'urgentUntil';
    job[field] = later(job[field], p.days);
    job[mp.plan === 'sponsored' ? 'sponsored' : 'urgent'] = true;
    purchase.expiresAt = job[field];
    await job.save({ session });
  } else {
    const user = await User.findById(employerId).session(session);
    const perks = user.employerPerks || {};
    if (mp.plan === 'top_hiring') { perks.topHiringUntil = later(perks.topHiringUntil, p.days); purchase.expiresAt = perks.topHiringUntil; }
    if (mp.plan === 'subscription') { perks.planUntil = later(perks.planUntil, p.days); perks.planJobLimit = p.jobLimit; purchase.expiresAt = perks.planUntil; }
    if (mp.plan === 'premium_tools') { perks.premiumUntil = later(perks.premiumUntil, p.days); purchase.expiresAt = perks.premiumUntil; }
    if (mp.plan === 'hiring_package') perks.featuredCredits = (perks.featuredCredits || 0) + (p.credits || 0);
    user.employerPerks = perks;
    user.markModified('employerPerks');
    await user.save({ session });
  }
  await EmployerPurchase.create([purchase], { session });
}

const active = (d) => Boolean(d && new Date(d) > new Date());

async function perksOf(employerId) {
  const u = await User.findById(employerId).select('employerPerks').lean();
  const p = u?.employerPerks || {};
  return { topHiring: active(p.topHiringUntil), topHiringUntil: p.topHiringUntil || null, subscription: active(p.planUntil), planUntil: p.planUntil || null, planJobLimit: p.planJobLimit || 0, premiumTools: active(p.premiumUntil), premiumUntil: p.premiumUntil || null, featuredCredits: p.featuredCredits || 0 };
}

// The employer's promotions screen: prices, what is active and every invoice.
async function mine(user, employerId) {
  const employer = await employerFor(user, employerId);
  const [cfg, perks, purchases, jobs] = await Promise.all([
    config(), perksOf(employer),
    EmployerPurchase.find({ employer }).populate('job', 'title').sort({ createdAt: -1 }).limit(100).lean(),
    Job.find({ postedBy: employer, institution: null, status: { $in: ['active', 'paused'] } }).select('title status featured featuredUntil sponsored sponsoredUntil urgent urgentUntil').sort({ createdAt: -1 }).lean()
  ]);
  const liveJobs = await Job.countDocuments({ postedBy: employer, institution: null, status: 'active' });
  return { config: cfg, perks, purchases, jobs, liveJobs, jobLimit: await jobLimitFor(employer, cfg, perks) };
}

async function invoice(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Invoice not found.', 404);
  const inv = await EmployerPurchase.findById(id).populate('employer', 'fullName email').populate('boughtBy', 'fullName').populate('job', 'title').lean();
  if (!inv) throw fail('Invoice not found.', 404);
  if (String(inv.employer._id) !== String(user._id) && !(await require('./employerStaff.service').hasPermission(user._id, inv.employer._id, ['manage_payments']))) throw fail('Invoice not found.', 404);
  return inv;
}

// Live-job limit: none unless the Super Admin sets a free limit; a subscription raises it.
async function jobLimitFor(employerId, cfg, perks) {
  const c = cfg || await config();
  if (!c.freeActiveJobs) return 0;
  const p = perks || await perksOf(employerId);
  return p.subscription ? Math.max(p.planJobLimit || 0, c.freeActiveJobs) : c.freeActiveJobs;
}
async function assertMayGoLive(employerId, exceptJobId) {
  if (!(await isRoleVerified(employerId, 'employer'))) return;
  const limit = await jobLimitFor(employerId);
  if (!limit) return;
  const live = await Job.countDocuments({ postedBy: employerId, institution: null, status: 'active', ...(exceptJobId ? { _id: { $ne: exceptJobId } } : {}) });
  if (live >= limit) throw fail(`You can keep ${limit} job${limit === 1 ? '' : 's'} live at once. Close one, or buy the Employer Subscription to keep more live.`, 403);
}

// Hiring Package: feature a job with a credit instead of paying.
async function useFeaturedCredit(user, jobId, employerId) {
  const employer = await employerFor(user, employerId);
  if (!mongoose.isValidObjectId(jobId)) throw fail('Job not found.', 404);
  const { job, days } = await require('../controllers/job.controller').loadFeaturableJob(jobId, employer);
  const taken = await User.findOneAndUpdate({ _id: employer, 'employerPerks.featuredCredits': { $gte: 1 } }, { $inc: { 'employerPerks.featuredCredits': -1 } });
  if (!taken) throw fail('No Featured Job credits left. Buy a Hiring Package first.', 409);
  const until = new Date(Date.now() + days * 864e5);
  await Job.updateOne({ _id: job._id }, { $set: { featured: true, featuredUntil: until } });
  await require('../models/FeaturedListing').create({ listingType: 'job', job: job._id, purchasedBy: employer, amount: 0, currency: 'PKR', paymentMethod: 'other', paymentReference: 'Hiring Package credit', status: 'paid', expiresAt: until });
  return { featuredUntil: until, creditsLeft: (taken.employerPerks?.featuredCredits || 1) - 1 };
}

// Premium tool: the applicants of one job as a CSV file.
async function applicantsCsv(user, jobId) {
  if (!mongoose.isValidObjectId(jobId)) throw fail('Job not found.', 404);
  const job = await Job.findById(jobId).select('title postedBy institution agreement');
  if (!job || !(await require('./jobAccess.service').canManageJob(job, user, 'manage_applicants'))) throw fail('Job not found.', 404);
  if (!(await perksOf(job.postedBy)).premiumTools) throw fail('Applicant download is a Premium Recruitment Tool. Buy it from Promotions & Packages.', 402);
  const apps = await require('../models/JobApplication').find({ job: job._id }).populate('applicant', 'fullName email phone city').sort({ createdAt: 1 }).lean();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'Email', 'Phone', 'City', 'Status', 'Applied on', 'AI match', 'Skills']].concat(apps.map((a) => [a.applicant?.fullName, a.applicant?.email, a.applicant?.phone, a.applicant?.city, a.status, new Date(a.createdAt).toISOString().slice(0, 10), a.aiMatch?.score ?? '', (a.resumeSnapshot?.skills || []).join('; ')]));
  return { filename: `${job.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60) || 'job'}-applicants.csv`, csv: rows.map((r) => r.map(cell).join(',')).join('\r\n') };
}

// Super Admin: package sales.
async function adminSales() {
  const [byPackage, recent] = await Promise.all([
    EmployerPurchase.aggregate([{ $group: { _id: '$package', count: { $sum: 1 }, total: { $sum: '$amount' }, tax: { $sum: '$taxAmount' } } }]),
    EmployerPurchase.find().populate('employer', 'fullName').sort({ createdAt: -1 }).limit(30).lean()
  ]);
  const featured = await require('../models/FeaturedListing').aggregate([{ $match: { status: 'paid', amount: { $gt: 0 } } }, { $group: { _id: '$currency', count: { $sum: 1 }, total: { $sum: '$amount' } } }]);
  return { byPackage, featured, recent };
}

module.exports = { DEFAULTS, config, setConfig, resolve, grant, perksOf, mine, invoice, assertMayGoLive, useFeaturedCredit, applicantsCsv, adminSales };
