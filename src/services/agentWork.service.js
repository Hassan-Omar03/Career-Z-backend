const mongoose = require('mongoose');
const Job = require('../models/Job');
const User = require('../models/User');
const Commission = require('../models/Commission');
const AppError = require('../utils/AppError');
const { notify, notifyAdmins } = require('./notification.service');
const { rateFor } = require('../utils/commissionSettings');

// Master "Jobs" chapter: a verified agent posts jobs, manages candidates and earns a commission
// that the EMPLOYER pays on a successful hire. So an agent's own job names the employer on
// CareerZ it recruits for; the employer accepts (with the commission rate), and after a hire
// pays the agent through CareerZ (CareerZ's service fee, then the agent's own account).
// Master Super Admin rules: list agents, their activity, verify, suspend, posting bans and
// licence cancellation.

const fail = (m, c = 422) => new AppError(m, c);
const oid = (v) => mongoose.isValidObjectId(v);

// ---------------------------------------------------------------- posting rules
function postingBlock(user) {
  const s = user.agentSanctions || {};
  if (s.licenceCancelledAt) return 'Your CareerZ agent licence was cancelled. Contact CareerZ support.';
  if (s.postingBanned && (!s.postingBanUntil || new Date(s.postingBanUntil) > new Date())) {
    return `You cannot post jobs ${s.postingBanUntil ? `until ${new Date(s.postingBanUntil).toDateString()}` : 'at the moment'}. Reason: ${s.reason || 'CareerZ review'}.`;
  }
  return '';
}
async function assertMayPost(user) {
  const fresh = await User.findById(user._id).select('agentSanctions roles');
  const block = fresh ? postingBlock(fresh) : '';
  if (block) throw fail(block, 403);
}

// ---------------------------------------------------------------- employer link
// The agent names the employer (their CareerZ account email) the job is for.
async function linkEmployer(job, agent, email) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return job;
  const employer = await User.findOne({ email: address, status: 'active' }).select('fullName roles');
  if (!employer || !employer.roles.includes('employer')) throw fail('No employer account on CareerZ uses that email. Ask the employer to join CareerZ as an employer first.');
  if (!(await require('../utils/roleVerification').isRoleVerified(employer._id, 'employer'))) throw fail(`${employer.fullName} is not a verified employer yet.`, 409);
  if (String(employer._id) === String(agent._id)) throw fail('You cannot recruit for yourself.', 403);
  const ratePercent = await rateFor('commission_rate_percent');
  job.representedEmployer = employer._id;
  job.employerConsent = { status: 'pending', ratePercent, at: null, note: '' };
  await job.save();
  await notify(employer._id, {
    title: `Agent request: ${job.title}`,
    body: `${agent.fullName} wants to recruit for you for "${job.title}". On a successful hire you pay the agent ${ratePercent}% of the salary through CareerZ. Accept or decline in Jobs → Agent requests.`,
    link: '/dashboard?tab=jobs&sub=agentRequests', sentBy: agent._id
  }).catch(() => {});
  return job;
}

async function employerRequests(user) {
  return Job.find({ representedEmployer: user._id }).select('title company status city country employerConsent postedBy createdAt').populate('postedBy', 'fullName email phone').sort({ createdAt: -1 }).limit(200).lean();
}

async function respond(user, jobId, { accept, note }) {
  if (!oid(jobId)) throw fail('Job not found.', 404);
  const job = await Job.findOne({ _id: jobId, representedEmployer: user._id });
  if (!job) throw fail('Job not found.', 404);
  if (job.employerConsent?.status !== 'pending') throw fail('This request was already answered.', 409);
  const text = String(note || '').trim().slice(0, 300);
  if (!accept && !text) throw fail('Tell the agent why you decline.');
  job.employerConsent = { ...job.employerConsent.toObject?.() || job.employerConsent, status: accept ? 'accepted' : 'declined', at: new Date(), note: text };
  await job.save();
  await notify(job.postedBy, {
    title: accept ? `Employer accepted: ${job.title}` : `Employer declined: ${job.title}`,
    body: accept ? `${user.fullName} confirmed you recruit for this job at ${job.employerConsent.ratePercent}% commission.` : text,
    link: require('../utils/dashLinks').manager(job), sentBy: user._id
  }).catch(() => {});
  return job;
}

// Commission for an agent's own job: only when an employer on CareerZ accepted the job, and that
// employer pays it. Without an accepted employer no commission is recorded (nobody would pay it).
async function commissionFor(job, base) {
  if (!job.representedEmployer || job.employerConsent?.status !== 'accepted') return null;
  const rate = Number(job.employerConsent.ratePercent) || 0;
  return { employer: job.representedEmployer, rate, amount: Math.round((Number(base || 0) * rate) / 100) };
}
async function tellEmployerToPay(commission, jobTitle) {
  if (!commission?.employer) return;
  await notify(commission.employer, {
    title: `Agent commission to pay: ${commission.currency} ${commission.amount}`,
    body: `A candidate joined for "${jobTitle}". Pay the agent's commission in Jobs → Agent requests (CareerZ service fee first, then the agent).`,
    link: '/dashboard?tab=jobs&sub=agentRequests'
  }).catch(() => {});
}
async function employerCommissions(user) {
  return Commission.find({ employer: user._id }).populate('job', 'title').populate('agent', 'fullName email phone').sort({ createdAt: -1 }).limit(200).lean();
}

// ---------------------------------------------------------------- Super Admin
async function profileOf(userId) {
  const p = await require('../models/UserProfile').findOne({ user: userId, role: 'education_agent' }).select('fields subtype').lean();
  return p || { fields: {} };
}
async function listAgents({ q = '', status = '' } = {}) {
  const filter = { roles: 'education_agent' };
  if (status) filter.status = status;
  if (q) filter.$or = [{ fullName: new RegExp(String(q).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { email: String(q).toLowerCase().trim() }];
  const agents = await User.find(filter).select('fullName email phone status country city agentSanctions createdAt').sort({ createdAt: -1 }).limit(300).lean();
  const ids = agents.map((a) => a._id);
  const [jobs, hires, profiles, requests] = await Promise.all([
    Job.aggregate([{ $match: { postedBy: { $in: ids } } }, { $group: { _id: '$postedBy', n: { $sum: 1 } } }]),
    Commission.aggregate([{ $match: { agent: { $in: ids }, status: { $ne: 'cancelled' } } }, { $group: { _id: '$agent', n: { $sum: 1 } } }]),
    require('../models/UserProfile').find({ user: { $in: ids }, role: 'education_agent' }).select('user fields subtype').lean(),
    require('../models/RoleRequest').find({ user: { $in: ids }, requestedRole: 'education_agent' }).select('user status').lean()
  ]);
  const count = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
  const jobN = count(jobs);
  const hireN = count(hires);
  const prof = Object.fromEntries(profiles.map((p) => [String(p.user), p]));
  const verif = Object.fromEntries(requests.map((r) => [String(r.user), r.status]));
  return agents.map((a) => ({
    ...a, kind: prof[String(a._id)]?.subtype || '', company: prof[String(a._id)]?.fields?.agencyName || '', country: prof[String(a._id)]?.fields?.country || a.country || '',
    verification: verif[String(a._id)] || 'not_requested', jobs: jobN[String(a._id)] || 0, hires: hireN[String(a._id)] || 0
  }));
}

async function activity(agentId) {
  if (!oid(agentId)) throw fail('Agent not found.', 404);
  const agent = await User.findById(agentId).select('fullName email phone status roles agentSanctions createdAt').lean();
  if (!agent) throw fail('Agent not found.', 404);
  const [jobs, commissions, scholarships, complaints, profile] = await Promise.all([
    Job.find({ postedBy: agentId }).select('title company status employerConsent representedEmployer createdAt').populate('representedEmployer', 'fullName email').sort({ createdAt: -1 }).limit(100).lean(),
    Commission.find({ agent: agentId }).populate('job', 'title').populate('employer', 'fullName').sort({ createdAt: -1 }).limit(100).lean(),
    require('../models/Scholarship').find({ publishedBy: agentId }).select('title status createdAt').limit(100).lean().catch(() => []),
    require('../models/Complaint').find({ targetType: { $in: ['agent', 'user'] }, targetId: agentId }).select('subject category status createdAt').limit(100).lean().catch(() => []),
    profileOf(agentId)
  ]);
  const jobIds = jobs.map((j) => j._id);
  const stages = await require('../models/JobApplication').aggregate([{ $match: { job: { $in: jobIds } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  return { agent, profile: profile.fields || {}, kind: profile.subtype || '', jobs, commissions, scholarships, complaints, applicationsByStage: Object.fromEntries(stages.map((s) => [s._id, s.n])) };
}

async function setPostingBan(admin, agentId, { banned, days, reason }) {
  if (!oid(agentId)) throw fail('Agent not found.', 404);
  const text = String(reason || '').trim().slice(0, 300);
  if (banned && !text) throw fail('Write the reason; the agent is told.');
  const until = banned && Number(days) > 0 ? new Date(Date.now() + Number(days) * 864e5) : null;
  const agent = await User.findOneAndUpdate({ _id: agentId, roles: 'education_agent' }, { $set: { 'agentSanctions.postingBanned': Boolean(banned), 'agentSanctions.postingBanUntil': until, 'agentSanctions.reason': banned ? text : '', 'agentSanctions.by': admin._id } }, { new: true });
  if (!agent) throw fail('Agent not found.', 404);
  await notify(agent._id, banned ? { title: 'Job posting paused by CareerZ', body: `${text}${until ? ` Until ${until.toDateString()}.` : ''}` } : { title: 'You can post jobs again', body: 'CareerZ lifted the posting restriction.' }).catch(() => {});
  return agent.agentSanctions;
}

// Licence cancelled: the agent role is removed (the account itself stays), open jobs close.
async function cancelLicence(admin, agentId, { reason }) {
  if (!oid(agentId)) throw fail('Agent not found.', 404);
  const text = String(reason || '').trim().slice(0, 300);
  if (!text) throw fail('Write the reason; the agent is told.');
  const agent = await User.findOneAndUpdate({ _id: agentId, roles: 'education_agent' }, { $pull: { roles: 'education_agent' }, $set: { 'agentSanctions.licenceCancelledAt': new Date(), 'agentSanctions.reason': text, 'agentSanctions.by': admin._id } }, { new: true });
  if (!agent) throw fail('Agent not found.', 404);
  await require('../models/RoleRequest').updateMany({ user: agentId, requestedRole: 'education_agent', status: 'approved' }, { $set: { status: 'suspended', reviewNotes: `Licence cancelled: ${text}` } });
  const closed = await Job.updateMany({ postedBy: agentId, status: { $in: ['active', 'paused', 'pending_review', 'draft'] } }, { $set: { status: 'closed' } });
  await notify(agent._id, { title: 'Your CareerZ agent licence was cancelled', body: text }, { email: true }).catch(() => {});
  await notifyAdmins({ title: `Agent licence cancelled: ${agent.fullName}`, body: `${text} (${closed.modifiedCount} job(s) closed)` }).catch(() => {});
  return { closedJobs: closed.modifiedCount };
}

// ---------------------------------------------------------------- AI (optional, the person's own key)
async function improveDescription(user, { title, company, description, skills }) {
  const t = String(title || '').trim().slice(0, 120);
  if (!t) throw fail('Write the job title first.');
  const ai = require('./ai.service');
  const text = await ai.generate(user._id,
    'You write clear, honest job descriptions for a Pakistani careers platform. Plain text, no markdown headings with #. Sections: About the role, Responsibilities (bullets with "- "), Requirements (bullets), What we offer. Never invent salary, visa or legal promises.',
    `Job title: ${t}\nCompany: ${String(company || '').slice(0, 120)}\nSkills: ${[].concat(skills || []).join(', ').slice(0, 400)}\nCurrent description:\n${String(description || '').slice(0, 4000)}\n\nRewrite it to be complete and attractive.`);
  return { description: String(text || '').trim() };
}

async function rankApplicants(user, jobId) {
  const job = await Job.findById(jobId);
  if (!job) throw fail('Job not found.', 404);
  if (!(await require('./jobAccess.service').canSeeCandidates(job, user))) throw fail('You cannot see these candidates.', 403);
  const apps = await require('../models/JobApplication').find({ job: job._id, status: { $nin: ['withdrawn', 'rejected'] } }).populate('applicant', 'fullName').limit(40).lean();
  if (!apps.length) return { ranking: [] };
  const brief = apps.map((a, i) => {
    const r = a.resumeSnapshot || {};
    const exp = (r.experience || []).map((e) => `${e.title || ''} at ${e.company || ''}`).join('; ');
    return `#${i + 1} ${a.applicant?.fullName || 'Candidate'} | skills: ${(r.skills || []).join(', ')} | experience: ${exp} | education: ${(r.education || []).map((e) => e.degree || '').join(', ')} | cover: ${String(a.coverLetter || '').slice(0, 300)}`;
  }).join('\n').slice(0, 12000);
  const ai = require('./ai.service');
  const text = await ai.generate(user._id,
    'You help a recruiter shortlist. Rank candidates only on job fit from the given data. Never use name, gender, religion, age or origin. Reply ONLY as JSON: [{"n":<candidate number>,"score":<0-100>,"reason":"<one sentence>"}].',
    `Job: ${job.title}\nSkills wanted: ${(job.skills || []).join(', ')}\nExperience wanted: ${job.experienceYears || ''}\nDescription: ${String(job.description || '').slice(0, 2000)}\n\nCandidates:\n${brief}`);
  let list = [];
  try { list = JSON.parse(String(text).slice(String(text).indexOf('['), String(text).lastIndexOf(']') + 1)); } catch { throw fail('The AI answer could not be read. Try again.', 502); }
  const ranking = list.filter((x) => apps[Number(x.n) - 1]).map((x) => ({ applicationId: apps[Number(x.n) - 1]._id, name: apps[Number(x.n) - 1].applicant?.fullName || 'Candidate', score: Math.max(0, Math.min(100, Number(x.score) || 0)), reason: String(x.reason || '').slice(0, 300) })).sort((a, b) => b.score - a.score);
  return { ranking };
}

// Market trends (master: the agent's AI tells market trends): from CareerZ's own jobs of the last
// 90 days — demand by field and city, salaries, wanted skills and competition. The numbers need no
// AI; with the person's own AI key a short reading of them is added.
async function marketTrends(user, { ai = false } = {}) {
  const since = new Date(Date.now() - 90 * 864e5);
  const match = { createdAt: { $gte: since }, status: { $in: ['active', 'paused', 'closed', 'filled'] } };
  const [byCategory, byCity, skills, salaries, apps] = await Promise.all([
    Job.aggregate([{ $match: match }, { $group: { _id: '$category', jobs: { $sum: 1 } } }, { $sort: { jobs: -1 } }, { $limit: 10 }]),
    Job.aggregate([{ $match: { ...match, city: { $nin: [null, ''] } } }, { $group: { _id: { $toLower: '$city' }, jobs: { $sum: 1 } } }, { $sort: { jobs: -1 } }, { $limit: 8 }]),
    Job.aggregate([{ $match: match }, { $unwind: '$skills' }, { $group: { _id: { $toLower: '$skills' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }]),
    Job.aggregate([{ $match: { ...match, currency: 'PKR', salaryMin: { $gt: 0 } } }, { $group: { _id: '$category', avgMin: { $avg: '$salaryMin' }, avgMax: { $avg: '$salaryMax' }, jobs: { $sum: 1 } } }, { $sort: { jobs: -1 } }, { $limit: 8 }]),
    require('../models/JobApplication').aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $lookup: { from: 'jobs', localField: 'job', foreignField: '_id', as: 'j' } }, { $unwind: '$j' },
      { $group: { _id: '$j.category', applications: { $sum: 1 }, jobs: { $addToSet: '$j._id' } } },
      { $project: { applications: 1, perJob: { $divide: ['$applications', { $max: [{ $size: '$jobs' }, 1] }] } } },
      { $sort: { applications: -1 } }, { $limit: 8 }
    ])
  ]);
  const round = (n) => Math.round(n || 0);
  const stats = {
    periodDays: 90,
    jobsByField: byCategory.map((r) => ({ field: r._id || 'other', jobs: r.jobs })),
    jobsByCity: byCity.map((r) => ({ city: r._id, jobs: r.jobs })),
    topSkills: skills.map((r) => ({ skill: r._id, jobs: r.n })),
    salaryPkr: salaries.map((r) => ({ field: r._id || 'other', avgMin: round(r.avgMin), avgMax: round(r.avgMax), jobs: r.jobs })),
    competition: apps.map((r) => ({ field: r._id || 'other', applications: r.applications, perJob: Math.round(r.perJob * 10) / 10 }))
  };
  if (!ai) return { stats };
  const text = await require('./ai.service').generate(user._id,
    'You advise a recruitment agent in Pakistan. Using ONLY the numbers given, write 5 to 7 short bullet points starting with "- " on where demand is, which fields have few applicants per job (easier placements), salary levels and skills to look for in candidates. Never invent figures.',
    JSON.stringify(stats));
  return { stats, insight: String(text || '').trim() };
}

module.exports = { marketTrends, postingBlock, assertMayPost, linkEmployer, employerRequests, respond, commissionFor, tellEmployerToPay, employerCommissions, listAgents, activity, setPostingBan, cancelLicence, improveDescription, rankApplicants };
