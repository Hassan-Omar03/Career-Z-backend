const Job = require('../models/Job');
const AppError = require('../utils/AppError');

const fail = (message, status = 422) => new AppError(message, status);
const median = (list) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What similar CareerZ jobs paid and asked for in the last 180 days (the AI's market facts).
async function similarJobs(words, country) {
  const keys = words.filter((w) => w.length > 2).slice(0, 4);
  if (!keys.length) return { count: 0 };
  const filter = { createdAt: { $gte: new Date(Date.now() - 180 * 864e5) }, status: { $in: ['active', 'closed', 'filled'] }, $or: keys.map((w) => ({ title: { $regex: escape(w), $options: 'i' } })) };
  if (country) filter.country = new RegExp(`^${escape(String(country))}$`, 'i');
  const jobs = await Job.find(filter).select('salaryMin salaryMax currency skills city').limit(200).lean();
  const pkr = jobs.filter((j) => (j.currency || 'PKR') === 'PKR');
  const skillCount = {};
  jobs.forEach((j) => (j.skills || []).forEach((s) => { const k = String(s).toLowerCase(); skillCount[k] = (skillCount[k] || 0) + 1; }));
  return {
    count: jobs.length,
    salaryMinMedian: median(pkr.map((j) => j.salaryMin).filter((n) => n > 0)),
    salaryMaxMedian: median(pkr.map((j) => j.salaryMax).filter((n) => n > 0)),
    topSkills: Object.entries(skillCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k),
    cities: [...new Set(jobs.map((j) => j.city).filter(Boolean))].slice(0, 6)
  };
}

// Master 12.4 AI Job Builder: from one line ("Need English Teacher") the employer's own AI
// provider drafts the job — description, skills, interview questions, salary suggestion and a
// short market analysis grounded in CareerZ's own recent jobs. Nothing is posted; the employer
// reviews and edits the draft in the job form.
async function buildJobDraft(user, { brief, country, city, company } = {}) {
  const line = String(brief || '').trim().slice(0, 300);
  if (line.length < 4) throw fail('Write one line about the job, for example "Need English Teacher".');
  const market = await similarJobs(line.split(/\s+/), country);
  const ai = require('./ai.service');
  const text = await ai.generate(user._id,
    'You help an employer on a Pakistani careers platform draft a job post. Use ONLY the given facts for market numbers; if none, say salary data is limited. Plain text inside JSON strings, no markdown headings. Reply ONLY with JSON: {"title":"","category":"","description":"About the role, Responsibilities (- bullets), Requirements (- bullets), What we offer","skills":["",""],"experienceYears":0,"education":"","interviewQuestions":["",""],"salarySuggestion":{"min":0,"max":0,"currency":"PKR","note":""},"marketAnalysis":""}',
    `Employer request: ${line}\nCompany: ${String(company || '').slice(0, 120)}\nCountry: ${String(country || '').slice(0, 60)}\nCity: ${String(city || '').slice(0, 60)}\nCareerZ market facts (last 180 days): ${JSON.stringify(market)}`);
  let draft;
  try { const s = String(text); draft = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { throw fail('The AI answer could not be read. Try again.', 502); }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
  const list = (v, n) => [].concat(v || []).map((x) => String(x).trim()).filter(Boolean).slice(0, n);
  return {
    title: String(draft.title || line).slice(0, 120),
    category: String(draft.category || ''),
    description: String(draft.description || '').slice(0, 6000),
    skills: list(draft.skills, 15),
    experienceYears: Math.max(0, Math.min(40, Number(draft.experienceYears) || 0)),
    education: String(draft.education || '').slice(0, 200),
    interviewQuestions: list(draft.interviewQuestions, 12),
    salarySuggestion: { min: num(draft.salarySuggestion?.min), max: num(draft.salarySuggestion?.max), currency: String(draft.salarySuggestion?.currency || 'PKR').slice(0, 3).toUpperCase(), note: String(draft.salarySuggestion?.note || '').slice(0, 300) },
    marketAnalysis: String(draft.marketAnalysis || '').slice(0, 1500),
    market
  };
}

module.exports = { buildJobDraft, similarJobs };

// ---------------------------------------------------------------- Employer analytics (12.19) + dashboard (12.1)

const ADVANCED = ['shortlisted', 'interview', 'final_interview', 'selected', 'accepted', 'hired', 'completed'];
const DECIDED_GOOD = ADVANCED;
const round1 = (n) => Math.round(n * 10) / 10;

// owner: the employer (or the agent) whose own jobs are counted.
async function analytics(owner) {
  const JobApplication = require('../models/JobApplication');
  const jobs = await Job.find({ postedBy: owner, institution: null }).select('title status views createdAt applicationDeadline').sort({ createdAt: -1 }).lean();
  const ids = jobs.map((j) => j._id);
  const [apps, guests, featured, commissions, promotions] = await Promise.all([
    JobApplication.find({ job: { $in: ids } }).select('job status createdAt statusHistory aiMatch').lean(),
    require('../models/GuestApplication').aggregate([{ $match: { job: { $in: ids }, emailVerified: true } }, { $group: { _id: '$job', n: { $sum: 1 } } }]),
    require('../models/FeaturedListing').find({ job: { $in: ids }, status: 'paid' }).select('amount currency').lean(),
    require('../models/Commission').find({ employer: owner, status: { $in: ['approved', 'available', 'paid'] } }).select('amount grossFee currency').lean(),
    loadPromotionSpend(owner)
  ]);
  const guestBy = Object.fromEntries(guests.map((g) => [String(g._id), g.n]));
  const qualified = (a) => ADVANCED.includes(a.status) || (a.aiMatch?.score ?? -1) >= 60;
  const hiredAt = (a) => (a.statusHistory || []).find((h) => h.status === 'hired')?.at;
  const hires = apps.filter((a) => ['hired', 'completed'].includes(a.status));
  const hireDays = hires.map((a) => hiredAt(a) && (new Date(hiredAt(a)) - new Date(a.createdAt)) / 864e5).filter((d) => d >= 0);
  // AI match accuracy: of the AI-scored applications the employer has decided on, how often the
  // AI's call (score 60+ = a fit) matched the decision (moved forward vs rejected).
  const judged = apps.filter((a) => a.aiMatch?.score != null && (DECIDED_GOOD.includes(a.status) || a.status === 'rejected'));
  const agreed = judged.filter((a) => (a.aiMatch.score >= 60) === DECIDED_GOOD.includes(a.status));
  const spendPKR = [...featured, ...promotions].filter((x) => (x.currency || 'PKR') === 'PKR').reduce((s, x) => s + (x.amount || 0), 0)
    + commissions.filter((c) => (c.currency || 'PKR') === 'PKR').reduce((s, c) => s + (c.grossFee || c.amount || 0), 0);
  const perJob = jobs.map((j) => {
    const mine = apps.filter((a) => String(a.job) === String(j._id));
    const applied = mine.length + (guestBy[String(j._id)] || 0);
    return { _id: j._id, title: j.title, status: j.status, views: j.views || 0, applied, qualified: mine.filter(qualified).length, shortlisted: mine.filter((a) => ADVANCED.includes(a.status)).length, hired: mine.filter((a) => ['hired', 'completed'].includes(a.status)).length, conversion: j.views ? round1(100 * applied / j.views) : null };
  });
  const totalApplied = perJob.reduce((s, j) => s + j.applied, 0);
  return {
    totals: {
      views: perJob.reduce((s, j) => s + j.views, 0),
      applied: totalApplied,
      qualified: apps.filter(qualified).length,
      hired: hires.length,
      hiringTimeDays: hireDays.length ? round1(hireDays.reduce((s, d) => s + d, 0) / hireDays.length) : null,
      spendPKR,
      costPerHirePKR: hires.length ? Math.round(spendPKR / hires.length) : null,
      aiMatchAccuracy: judged.length ? Math.round(100 * agreed.length / judged.length) : null,
      aiJudged: judged.length
    },
    jobs: perJob
  };
}

// Promotion purchases (job packages) count toward cost per hire once they exist.
async function loadPromotionSpend(owner) {
  try { return await require('../models/EmployerPurchase').find({ employer: owner, status: 'paid' }).select('amount currency').lean(); } catch { return []; }
}

// The employer's full dashboard: every count in one call.
async function dashboard(owner) {
  const JobApplication = require('../models/JobApplication');
  const jobs = await Job.find({ postedBy: owner, institution: null }).select('status').lean();
  const ids = jobs.map((j) => j._id);
  const byStatus = jobs.reduce((m, j) => ({ ...m, [j.status]: (m[j.status] || 0) + 1 }), {});
  const [apps, interviews, unreadMessages, unreadNotifications, roleRequest, trust, employees] = await Promise.all([
    JobApplication.aggregate([{ $match: { job: { $in: ids } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    require('../models/Interview').countDocuments({ job: { $in: ids }, status: 'scheduled', scheduledDate: { $gte: new Date() } }),
    require('../models/Message').countDocuments({ to: owner, read: false }),
    require('../models/Notification').countDocuments({ user: owner, read: false }),
    require('../models/RoleRequest').findOne({ user: owner, requestedRole: 'employer' }).sort({ createdAt: -1 }).select('status subtype').lean(),
    require('./employerTrust.service').trustScore(owner),
    require('../models/Employment').countDocuments({ employer: owner, status: 'active' })
  ]);
  const a = Object.fromEntries(apps.map((x) => [x._id, x.n]));
  return {
    activeJobs: byStatus.active || 0, closedJobs: (byStatus.closed || 0) + (byStatus.filled || 0), draftJobs: byStatus.draft || 0, pausedJobs: byStatus.paused || 0, pendingReview: byStatus.pending_review || 0,
    applications: apps.reduce((s, x) => s + x.n, 0), shortlisted: ADVANCED.reduce((s, k) => s + (a[k] || 0), 0), interviews, hired: (a.hired || 0) + (a.completed || 0), employees,
    unreadMessages, unreadNotifications, verification: roleRequest?.status || 'none', subtype: roleRequest?.subtype || '',
    rating: trust.averageRating, reviewCount: trust.reviewCount, trustScore: trust.score, trustLevel: trust.level, sanction: trust.sanction
  };
}

module.exports.analytics = analytics;
module.exports.dashboard = dashboard;
