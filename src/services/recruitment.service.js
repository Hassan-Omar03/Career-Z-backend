const mongoose = require('mongoose');
const User = require('../models/User');
const Institution = require('../models/Institution');
const RoleRequest = require('../models/RoleRequest');
const RecruitmentRequest = require('../models/RecruitmentRequest');
const RecruitmentAgreement = require('../models/RecruitmentAgreement');
const RecruitmentInvoice = require('../models/RecruitmentInvoice');
const Commission = require('../models/Commission');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const GuestApplication = require('../models/GuestApplication');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const { hasStaffPermission } = require('../utils/staffRoles');
const { eligiblePublishers } = require('./publicListings.service');
const { notify, notifyAdmins } = require('./notification.service');
const { JOB_CATEGORIES } = require('../models/Job');

// Institute–Agent recruitment (proposed extension, client-approved direction):
//   request → agent accepts → both accept one agreement version → agent publishes jobs →
//   institute confirms joining → fee from the agreement → invoice → bank-transfer proof →
//   admin verifies receipt → agent earning released. Optional replacement/refund terms are the
//   parties' own and every refund or adjustment is an admin decision, never automatic.

const PERMISSION = 'recruitment:manage';
const PLATFORM_FEE_KEY = 'recruitment_platform_fee_percent';
const PAYMENT_KEY = 'recruitment_payment_settings';
const fail = (message, code = 422) => new AppError(message, code);
const oid = (id) => mongoose.isValidObjectId(id);
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---------------------------------------------------------------- access
async function institutionRecruiter(institutionId, user) {
  if (!oid(institutionId)) throw fail('Institute not found.', 404);
  const institution = await Institution.findById(institutionId);
  if (!institution) throw fail('Institute not found.', 404);
  if (!hasStaffPermission(institution, user._id, PERMISSION)) throw fail('Only the institute owner or staff with the recruitment permission can do this.', 403);
  if (institution.verificationStatus !== 'approved' || institution.status !== 'active') throw fail('The institute must be verified and active.', 403);
  return institution;
}
async function approvedAgent(agentId) {
  if (!oid(agentId)) throw fail('Agent not found.', 404);
  const [ok] = await eligiblePublishers([agentId], 'education_agent');
  if (!ok) throw fail('This agent is not verified or is not active.', 403);
  return User.findById(agentId).select('fullName email agentProfile city country');
}
// Which side of a request this user is on, or an error.
async function sideOf(request, user) {
  if (String(request.agent) === String(user._id)) return 'agent';
  const institution = await Institution.findById(request.institution).select('owner staff name');
  if (institution && hasStaffPermission(institution, user._id, PERMISSION)) return 'institution';
  throw fail('You are not part of this recruitment request.', 403);
}
async function requestFor(id, user) {
  if (!oid(id)) throw fail('Request not found.', 404);
  const request = await RecruitmentRequest.findById(id);
  if (!request) throw fail('Request not found.', 404);
  return { request, side: await sideOf(request, user) };
}
async function institutionRecipients(institutionId) {
  const inst = await Institution.findById(institutionId).select('owner staff name');
  const ids = new Set([String(inst.owner)]);
  for (const s of inst.staff || []) if ((s.permissions || []).includes(PERMISSION)) ids.add(String(s.user));
  return { inst, ids: [...ids] };
}
async function tellInstitution(institutionId, payload) {
  const { ids } = await institutionRecipients(institutionId);
  for (const id of ids) await notify(id, { ...payload, link: require('../utils/dashLinks').institutionAgents, category: 'recruitment' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
}
const tellAgent = (agentId, payload) => notify(agentId, { ...payload, link: /Payment verified|Earning/i.test(payload.title || '') ? require('../utils/dashLinks').agentCommission : require('../utils/dashLinks').agentRequests, category: 'recruitment' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});

// ---------------------------------------------------------------- agents directory
function agentCard(u, agencyName, stats) {
  const p = u.agentProfile || {};
  return { _id: u._id, name: agencyName || u.fullName, person: u.fullName, city: u.city || '', country: u.country || '', specialties: p.specialties || [], serviceCountries: p.serviceCountries || [], serviceCities: p.serviceCities || [],
    experienceYears: p.experienceYears || 0, bio: p.bio || '', acceptingRequests: p.acceptingRequests !== false, verified: true, ...stats };
}
async function listAgents(query = {}) {
  const ids = await User.distinct('_id', { status: 'active', roles: 'education_agent' });
  const approved = await eligiblePublishers(ids, 'education_agent');
  const users = await User.find({ _id: { $in: approved } }).select('fullName city country agentProfile').lean();
  const requests = await RoleRequest.find({ user: { $in: approved }, requestedRole: 'education_agent', status: 'approved' }).select('user subtype').lean();
  const UserProfile = require('../models/UserProfile');
  const profiles = await UserProfile.find({ user: { $in: approved }, role: 'education_agent' }).select('user fields').lean().catch(() => []);
  const agencyOf = new Map(profiles.map((p) => [String(p.user), (p.fields || {}).agencyName || '']));
  const subtypeOf = new Map(requests.map((r) => [String(r.user), r.subtype || '']));
  const hires = await JobApplication.aggregate([{ $match: { status: { $in: ['hired', 'completed'] }, 'joining.confirmed': true } }, { $lookup: { from: 'jobs', localField: 'job', foreignField: '_id', as: 'j' } }, { $unwind: '$j' }, { $match: { 'j.postedBy': { $in: approved } } }, { $group: { _id: '$j.postedBy', n: { $sum: 1 } } }]);
  const hiresOf = new Map(hires.map((h) => [String(h._id), h.n]));
  const q = String(query.q || '').trim().toLowerCase(), city = String(query.city || '').trim().toLowerCase(), country = String(query.country || '').trim().toLowerCase(), category = query.category;
  return users.map((u) => agentCard(u, agencyOf.get(String(u._id)), { agency: subtypeOf.get(String(u._id)) === 'agency', confirmedHires: hiresOf.get(String(u._id)) || 0 }))
    .filter((a) => a.acceptingRequests)
    .filter((a) => !q || `${a.name} ${a.person} ${a.bio}`.toLowerCase().includes(q))
    .filter((a) => !city || a.city.toLowerCase() === city || a.serviceCities.some((c) => c.toLowerCase() === city))
    .filter((a) => !country || a.country.toLowerCase() === country || a.serviceCountries.some((c) => c.toLowerCase() === country))
    .filter((a) => !category || a.specialties.includes(category))
    .sort((a, b) => b.confirmedHires - a.confirmedHires || a.name.localeCompare(b.name));
}
async function saveAgentProfile(user, body = {}) {
  const specialties = [...new Set(Array.isArray(body.specialties) ? body.specialties : [])];
  if (specialties.some((c) => !JOB_CATEGORIES.includes(c))) throw fail('Choose valid specialties.');
  const list = (v, n) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((c) => String(c).trim().slice(0, 80)).filter(Boolean))].slice(0, n);
  const cities = list(body.serviceCities, 50), countries = list(body.serviceCountries, 30);
  const set = { 'agentProfile.specialties': specialties, 'agentProfile.serviceCities': cities, 'agentProfile.serviceCountries': countries, 'agentProfile.experienceYears': Math.max(0, Math.min(60, Number(body.experienceYears) || 0)),
    'agentProfile.bio': String(body.bio || '').slice(0, 1500), 'agentProfile.acceptingRequests': body.acceptingRequests !== false };
  return (await User.findByIdAndUpdate(user._id, { $set: set }, { new: true }).select('agentProfile')).agentProfile;
}

// ---------------------------------------------------------------- requests
function cleanPositions(list) {
  if (!Array.isArray(list) || !list.length) throw fail('Add at least one position.');
  return list.slice(0, 20).map((p, i) => {
    const title = String(p?.title || '').trim();
    if (!title) throw fail(`Position ${i + 1}: enter the job title.`);
    const vacancies = Number(p.vacancies);
    if (!Number.isInteger(vacancies) || vacancies < 1) throw fail(`Position ${i + 1}: vacancies must be a whole number of 1 or more.`);
    if (p.category && !JOB_CATEGORIES.includes(p.category)) throw fail(`Position ${i + 1}: choose a valid category.`);
    const salaryMin = p.salaryMin === '' || p.salaryMin == null ? null : Number(p.salaryMin);
    const salaryMax = p.salaryMax === '' || p.salaryMax == null ? null : Number(p.salaryMax);
    if (salaryMin != null && salaryMax != null && salaryMax < salaryMin) throw fail(`Position ${i + 1}: maximum salary is lower than minimum.`);
    return { title, category: p.category || 'other', vacancies, qualifications: String(p.qualifications || ''), experienceYears: Number(p.experienceYears) || 0, salaryMin, salaryMax,
      currency: String(p.currency || 'PKR').toUpperCase().slice(0, 3), employmentType: p.employmentType || 'full_time', responsibilities: String(p.responsibilities || '') };
  });
}
async function createRequest(user, body) {
  const institution = await institutionRecruiter(body.institution, user);
  const agent = await approvedAgent(body.agent);
  if (agent.agentProfile?.acceptingRequests === false) throw fail('This agent is not taking new requests right now.', 409);
  const request = await RecruitmentRequest.create({
    institution: institution._id, agent: agent._id, requestedBy: user._id, positions: cleanPositions(body.positions),
    city: String(body.city || institution.city || ''), country: String(body.country || institution.country || ''),
    hiringDeadline: body.hiringDeadline ? new Date(body.hiringDeadline) : null, specialRequirements: String(body.specialRequirements || ''), proposedFee: String(body.proposedFee || '')
  });
  await tellAgent(agent._id, { title: `New recruitment request from ${institution.name}`, body: request.positions.map((p) => `${p.vacancies} × ${p.title}`).join(', '), link: '/dashboard', sentBy: user._id });
  return request;
}
async function listRequests(user, query = {}) {
  if (query.institution) {
    const institution = await Institution.findById(query.institution).select('owner staff');
    if (!institution || !hasStaffPermission(institution, user._id, PERMISSION)) throw fail('You cannot see this institute\'s requests.', 403);
    return RecruitmentRequest.find({ institution: institution._id }).populate('agent', 'fullName').populate('activeAgreement').sort({ updatedAt: -1 }).lean();
  }
  return RecruitmentRequest.find({ agent: user._id }).populate('institution', 'name city logo').populate('activeAgreement').sort({ updatedAt: -1 }).lean();
}
async function respond(user, id, { action, message }) {
  const { request, side } = await requestFor(id, user);
  if (side !== 'agent') throw fail('Only the agent can answer this request.', 403);
  if (!['sent', 'clarification_requested'].includes(request.status)) throw fail('This request has already been answered.', 409);
  const text = String(message || '').trim().slice(0, 2000);
  if (action === 'clarify' && !text) throw fail('Write your question for the institute.');
  if (!['accept', 'reject', 'clarify'].includes(action)) throw fail('action must be accept, reject or clarify.');
  request.status = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'clarification_requested';
  if (text) request.messages.push({ by: user._id, side, text });
  await request.save();
  const verb = action === 'accept' ? 'accepted' : action === 'reject' ? 'declined' : 'asked a question about';
  await tellInstitution(request.institution, { title: `Agent ${verb} your recruitment request`, body: text || 'Open Jobs & Hiring → Agents to continue.', link: '/dashboard', sentBy: user._id });
  return request;
}
async function addMessage(user, id, text) {
  const { request, side } = await requestFor(id, user);
  const body = String(text || '').trim().slice(0, 2000);
  if (!body) throw fail('Write a message.');
  request.messages.push({ by: user._id, side, text: body });
  if (side === 'institution' && request.status === 'clarification_requested') request.status = 'sent';
  await request.save();
  if (side === 'agent') await tellInstitution(request.institution, { title: 'New message from your recruitment agent', body, link: '/dashboard', sentBy: user._id });
  else await tellAgent(request.agent, { title: 'New message on a recruitment request', body, link: '/dashboard', sentBy: user._id });
  return request;
}
async function cancelRequest(user, id) {
  const { request, side } = await requestFor(id, user);
  if (side !== 'institution') throw fail('Only the institute can cancel its request.', 403);
  if (['completed', 'cancelled'].includes(request.status)) throw fail('This request is already closed.', 409);
  request.status = 'cancelled';
  await request.save();
  await RecruitmentAgreement.updateMany({ request: request._id, status: { $in: ['proposed', 'active'] } }, { $set: { status: 'ended', endedAt: new Date() } });
  await tellAgent(request.agent, { title: 'Recruitment request cancelled by the institute', link: '/dashboard', sentBy: user._id });
  return request;
}

// ---------------------------------------------------------------- agreements
function cleanTerms(body, request) {
  const feeModel = body.feeModel;
  if (!['fixed_per_hire', 'percentage', 'package'].includes(feeModel)) throw fail('Choose a fee model: fixed per hire, percentage or package.');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const t = { feeModel, currency: String(body.currency || '').toUpperCase().trim().slice(0, 3), paymentDueDays: num(body.paymentDueDays), notes: String(body.notes || '').slice(0, 2000),
    fixedAmount: null, percentage: null, salaryBase: '', packageAmount: null, packageHires: null };
  if (!/^[A-Z]{3}$/.test(t.currency)) throw fail('Enter the currency as a 3-letter code, e.g. PKR.');
  if (!(Number.isInteger(t.paymentDueDays) && t.paymentDueDays >= 0 && t.paymentDueDays <= 365)) throw fail('Payment due days must be 0 to 365.');
  if (feeModel === 'fixed_per_hire') { t.fixedAmount = num(body.fixedAmount); if (!(t.fixedAmount > 0)) throw fail('Enter the fixed fee per successful hire.'); }
  if (feeModel === 'percentage') {
    t.percentage = num(body.percentage); t.salaryBase = body.salaryBase;
    if (!(t.percentage > 0 && t.percentage <= 100)) throw fail('Enter the percentage (more than 0, at most 100).');
    if (!['monthly_salary', 'annual_salary'].includes(t.salaryBase)) throw fail('Choose the salary base: monthly or annual salary.');
  }
  if (feeModel === 'package') {
    t.packageAmount = num(body.packageAmount); t.packageHires = num(body.packageHires);
    if (!(t.packageAmount > 0)) throw fail('Enter the package amount.');
    if (!(Number.isInteger(t.packageHires) && t.packageHires >= 1)) throw fail('Enter how many hires the package covers.');
  }
  const r = body.replacement || {};
  const rep = { periodDays: num(r.periodDays), deadlineDays: num(r.deadlineDays), attempts: num(r.attempts), exceptions: String(r.exceptions || '').slice(0, 1500), refundTerms: String(r.refundTerms || '').slice(0, 1500) };
  for (const [k, max] of [['periodDays', 365], ['deadlineDays', 365], ['attempts', 10]]) if (rep[k] != null && !(Number.isInteger(rep[k]) && rep[k] >= 1 && rep[k] <= max)) throw fail(`Replacement ${k}: whole number from 1 to ${max}, or leave it empty.`);
  if ((rep.periodDays == null) !== (rep.deadlineDays == null)) throw fail('Replacement terms need both the period and the replacement deadline, or neither.');
  t.replacement = rep;
  // Authorized positions: all request positions unless a subset is named.
  const chosen = Array.isArray(body.positions) && body.positions.length ? request.positions.filter((p) => body.positions.includes(String(p._id))) : request.positions;
  if (!chosen.length) throw fail('Choose at least one position from the request.');
  t.positions = chosen.map((p) => ({ title: p.title, category: p.category, vacancies: p.vacancies }));
  t.vacancyCount = chosen.reduce((n, p) => n + p.vacancies, 0);
  return t;
}
async function proposeTerms(user, requestId, body) {
  const { request, side } = await requestFor(requestId, user);
  if (!['accepted', 'agreed'].includes(request.status)) throw fail('Terms can be proposed once the agent has accepted the request.', 409);
  // The institute writes the terms; the agent reads them, accepts, or messages to ask for changes.
  if (side !== 'institution') throw fail('Only the institute proposes the terms. Message the institute to ask for changes.', 403);
  const terms = cleanTerms(body, request);
  const last = await RecruitmentAgreement.findOne({ request: request._id }).sort({ version: -1 }).select('version');
  await RecruitmentAgreement.updateMany({ request: request._id, status: 'proposed' }, { $set: { status: 'superseded' } });
  const agreement = await RecruitmentAgreement.create({
    ...terms, request: request._id, institution: request.institution, agent: request.agent, version: (last?.version || 0) + 1, proposedBy: user._id, proposedSide: side,
    ...(side === 'institution' ? { institutionAcceptance: { by: user._id, at: new Date() } } : { agentAcceptance: { by: user._id, at: new Date() } })
  });
  const payload = { title: `Recruitment terms proposed (version ${agreement.version})`, body: 'Review and accept or propose changes.', link: '/dashboard', sentBy: user._id };
  if (side === 'institution') await tellAgent(request.agent, payload); else await tellInstitution(request.institution, payload);
  return agreement;
}
async function agreementFor(id, user) {
  if (!oid(id)) throw fail('Agreement not found.', 404);
  const agreement = await RecruitmentAgreement.findById(id);
  if (!agreement) throw fail('Agreement not found.', 404);
  const request = await RecruitmentRequest.findById(agreement.request);
  return { agreement, request, side: await sideOf(request, user) };
}
async function acceptTerms(user, id) {
  const { agreement, request, side } = await agreementFor(id, user);
  if (agreement.status !== 'proposed') throw fail('Only the latest proposed version can be accepted.', 409);
  if (side === 'institution') agreement.institutionAcceptance = { by: user._id, at: new Date() };
  else {
    // The agent's own bank or wallet account (with the account holder's name) is where the
    // institute pays the agent's share; it is part of what the agent accepts.
    const me = await require('../models/User').findById(user._id).select('+payoutAccount');
    if (!me?.payoutAccount?.accountNumber) throw fail('Add your bank or wallet account (with the account holder name) in Wallet → Account where buyers pay you, then accept. The institute pays your fee there.', 409);
    const { method, bankName, accountTitle, accountNumber } = me.payoutAccount;
    agreement.agentPaymentAccount = { method, bankName, accountTitle, accountNumber };
    agreement.agentAcceptance = { by: user._id, at: new Date() };
  }
  if (agreement.institutionAcceptance?.by && agreement.agentAcceptance?.by) {
    await RecruitmentAgreement.updateMany({ request: request._id, status: 'active', _id: { $ne: agreement._id } }, { $set: { status: 'superseded' } });
    agreement.status = 'active';
    request.status = 'agreed';
    request.activeAgreement = agreement._id;
    await request.save();
  }
  await agreement.save();
  const payload = { title: agreement.status === 'active' ? `Recruitment agreement active (version ${agreement.version})` : 'Recruitment terms accepted by the other side', link: '/dashboard', sentBy: user._id };
  await tellAgent(request.agent, payload); await tellInstitution(request.institution, payload);
  return agreement;
}
async function declineTerms(user, id, note) {
  const { agreement, request, side } = await agreementFor(id, user);
  if (agreement.status !== 'proposed') throw fail('Only a proposed version can be declined.', 409);
  agreement.status = 'declined';
  agreement.notes = `${agreement.notes}${note ? `\nDeclined: ${String(note).slice(0, 500)}` : ''}`;
  await agreement.save();
  const payload = { title: `Recruitment terms (version ${agreement.version}) declined`, body: String(note || ''), link: '/dashboard', sentBy: user._id };
  if (side === 'institution') await tellAgent(request.agent, payload); else await tellInstitution(request.institution, payload);
  return agreement;
}
async function endAgreement(user, id) {
  const { agreement, request } = await agreementFor(id, user);
  if (agreement.status !== 'active') throw fail('Only an active agreement can be ended.', 409);
  agreement.status = 'ended'; agreement.endedAt = new Date();
  await agreement.save();
  request.status = 'completed';
  await request.save();
  await Job.updateMany({ agreement: agreement._id, status: { $in: ['active', 'paused', 'pending_review', 'draft'] } }, { $set: { status: 'closed' } });
  const payload = { title: 'Recruitment agreement ended', body: 'Its open jobs were closed. Invoices already issued stay payable.', link: '/dashboard', sentBy: user._id };
  await tellAgent(request.agent, payload); await tellInstitution(request.institution, payload);
  return agreement;
}
async function agreementsOf(user, requestId) {
  await requestFor(requestId, user);
  return RecruitmentAgreement.find({ request: requestId }).sort({ version: -1 }).lean();
}

// Used by job posting: an agent publishing for an institute needs an active agreement.
async function publishingAuthority(user, agreementId) {
  if (!oid(agreementId)) throw fail('Agreement not found.', 404);
  const agreement = await RecruitmentAgreement.findById(agreementId);
  if (!agreement || String(agreement.agent) !== String(user._id)) throw fail('You can only publish under your own agreement.', 403);
  if (agreement.status !== 'active') throw fail('This agreement is not active. Both sides must accept the terms first.', 403);
  const institution = await Institution.findById(agreement.institution);
  if (!institution || institution.verificationStatus !== 'approved' || institution.status !== 'active') throw fail('The institute is not verified and active.', 403);
  const published = await Job.countDocuments({ agreement: agreement._id, status: { $nin: ['rejected'] } });
  if (published >= agreement.positions.length * 5) throw fail('Too many jobs for this agreement. Edit an existing job instead.', 409);
  return { agreement, institution };
}

// ---------------------------------------------------------------- hires, fees and invoices
async function feeSettings() {
  const [fee, pay] = await Promise.all([Setting.findOne({ key: PLATFORM_FEE_KEY }).lean(), Setting.findOne({ key: PAYMENT_KEY }).lean()]);
  return { platformFeePercent: fee ? Number(fee.value) || 0 : 0, payment: pay?.value || { mode: '', instructions: '' } };
}
// Hires the institute is asked to confirm, for its agreement jobs.
async function hiresForInstitution(user, institutionId) {
  await institutionRecruiter(institutionId, user);
  const jobs = await Job.find({ institution: institutionId, agreement: { $ne: null } }).select('_id title agreement').lean();
  const apps = await JobApplication.find({ job: { $in: jobs.map((j) => j._id) }, status: { $in: ['hired', 'completed'] } }).populate('applicant', 'fullName').sort({ updatedAt: -1 }).lean();
  const guests = await GuestApplication.find({ job: { $in: jobs.map((j) => j._id) }, emailVerified: true, status: { $in: ['hired', 'completed'] } }).select('name job joining status updatedAt').lean();
  const byJob = new Map(jobs.map((j) => [String(j._id), j]));
  const row = (a, candidate, guest) => ({ _id: a._id, candidate, guest, job: byJob.get(String(a.job))?.title, jobId: a.job, agreement: byJob.get(String(a.job))?.agreement, joining: a.joining, status: a.status, updatedAt: a.updatedAt });
  return [...apps.map((a) => row(a, a.applicant?.fullName || 'Candidate', false)), ...guests.map((a) => row(a, a.name, true))].sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
}
function calculate(agreement, hireSalary, confirmedHires) {
  if (agreement.feeModel === 'fixed_per_hire') return { gross: agreement.fixedAmount, rate: 0, text: `Fixed fee per hire: ${agreement.currency} ${agreement.fixedAmount}` };
  if (agreement.feeModel === 'percentage') {
    const base = agreement.salaryBase === 'annual_salary' ? hireSalary * 12 : hireSalary;
    return { gross: money((base * agreement.percentage) / 100), rate: agreement.percentage, text: `${agreement.percentage}% of ${agreement.salaryBase === 'annual_salary' ? 'annual' : 'monthly'} salary ${agreement.currency} ${base}` };
  }
  if (confirmedHires === agreement.packageHires) return { gross: agreement.packageAmount, rate: 0, text: `Package for ${agreement.packageHires} hire(s): ${agreement.currency} ${agreement.packageAmount}` };
  return { gross: 0, rate: 0, text: `Package: hire ${confirmedHires} of ${agreement.packageHires}; invoiced when all are confirmed` };
}
// An agreement job's hire: a registered candidate's application or a guest's.
async function loadHire(id) {
  if (!oid(id)) throw fail('Hire not found.', 404);
  let application = await JobApplication.findById(id).populate('job').populate('applicant', 'fullName');
  let guest = false;
  if (!application) { application = await GuestApplication.findById(id).populate('job'); guest = true; }
  if (!application?.job?.agreement) throw fail('Hire not found.', 404);
  return { application, guest, name: guest ? application.name : application.applicant?.fullName || 'candidate' };
}
async function confirmHire(user, applicationId, body = {}) {
  const { application, guest, name } = await loadHire(applicationId);
  await institutionRecruiter(application.job.institution, user);
  if (application.status !== 'hired') throw fail('The agent has not marked this candidate as joined.', 409);
  if (application.joining?.confirmed) throw fail('Joining is already confirmed.', 409);
  const agreement = await RecruitmentAgreement.findById(application.job.agreement);
  if (!agreement || !['active', 'ended'].includes(agreement.status)) throw fail('There is no accepted agreement for this job.', 409);
  let salary = body.monthlySalary === '' || body.monthlySalary == null ? null : Number(body.monthlySalary);
  if (agreement.feeModel === 'percentage') {
    if (salary == null) salary = application.job.salaryMin || application.job.salaryMax || null;
    if (!(salary > 0)) throw fail('Enter the monthly salary agreed with the candidate; the fee is a percentage of it.');
  }
  application.joining = { confirmed: true, confirmedBy: user._id, confirmedAt: new Date(), via: 'hiring_organization' };
  application.statusHistory.push({ status: 'hired', by: user._id, byRole: 'hiring_organization', note: 'Institute confirmed joining' });
  await application.save();
  if (application.job.status !== 'filled') { application.job.status = 'filled'; await application.job.save(); }
  if (!guest) await require('./institutionHire.service').onInstituteJoining(application);

  const jobsOfAgreement = await Job.distinct('_id', { agreement: agreement._id });
  const confirmed = (await JobApplication.countDocuments({ job: { $in: jobsOfAgreement }, 'joining.confirmed': true })) + (await GuestApplication.countDocuments({ job: { $in: jobsOfAgreement }, 'joining.confirmed': true }));
  const calc = calculate(agreement, salary, confirmed);
  const { platformFeePercent } = await feeSettings();
  const platformFee = money((calc.gross * platformFeePercent) / 100);
  const processing = 0; // manual bank transfer: no gateway charge
  const commission = await Commission.create({
    agent: agreement.agent, job: application.job._id, ...(guest ? { guestApplication: application._id } : { application: application._id }), candidate: guest ? null : application.applicant?._id || null, candidateName: name,
    rate: calc.rate, amount: money(calc.gross - platformFee - processing), currency: agreement.currency, status: calc.gross > 0 ? 'pending' : 'cancelled',
    source: 'recruitment_agreement', agreement: agreement._id, grossFee: calc.gross, platformFee, processingCharges: processing, calculation: calc.text
  });
  let invoice = null;
  if (calc.gross > 0) {
    const count = await RecruitmentInvoice.countDocuments();
    invoice = await RecruitmentInvoice.create({
      number: `RCI-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`, agreement: agreement._id, institution: agreement.institution, agent: agreement.agent, commission: commission._id,
      description: `${application.job.title}: ${name} joined. ${calc.text}.`, currency: agreement.currency,
      grossFee: calc.gross, platformFee, processingCharges: processing, agentEarning: commission.amount, dueDate: new Date(Date.now() + agreement.paymentDueDays * 864e5),
      history: [{ action: 'issued', by: user._id, note: calc.text }]
    });
    commission.invoice = invoice._id;
    await commission.save();
  }
  await tellAgent(agreement.agent, { title: `Joining confirmed: ${application.job.title}`, body: invoice ? `Invoice ${invoice.number} issued to the institute: ${invoice.currency} ${invoice.grossFee}.` : calc.text, link: '/dashboard', sentBy: user._id });
  if (invoice) await tellInstitution(agreement.institution, { title: `Recruitment invoice ${invoice.number}`, body: `${invoice.currency} ${invoice.grossFee} due by ${invoice.dueDate.toDateString()}.`, link: '/dashboard', sentBy: user._id });
  return { application, commission, invoice };
}
async function declineHire(user, applicationId, reason) {
  const { application } = await loadHire(applicationId);
  await institutionRecruiter(application.job.institution, user);
  if (application.status !== 'hired' || application.joining?.confirmed) throw fail('There is no unconfirmed joining to decline.', 409);
  const note = String(reason || '').trim().slice(0, 500);
  if (!note) throw fail('Say why the joining is not confirmed.');
  application.status = 'accepted';
  application.statusHistory.push({ status: 'accepted', by: user._id, byRole: 'hiring_organization', note: `Joining not confirmed: ${note}` });
  await application.save();
  await tellAgent(application.job.postedBy, { title: `Joining not confirmed: ${application.job.title}`, body: note, link: '/dashboard', sentBy: user._id });
  return application;
}

async function candidatesForInstitution(user, institutionId) {
  await institutionRecruiter(institutionId, user);
  const jobs = await Job.find({ institution: institutionId, agreement: { $ne: null } }).select('_id title company city country currency salaryMin salaryMax type agreement postedBy').populate('postedBy', 'fullName').lean();
  const apps = await JobApplication.find({ job: { $in: jobs.map((j) => j._id) }, status: { $ne: 'withdrawn' } })
    .populate('applicant', 'fullName email phone city country').sort({ updatedAt: -1 }).lean();
  const Employment = require('../models/Employment'), Interview = require('../models/Interview');
  const [emps, interviews] = await Promise.all([
    Employment.find({ application: { $in: apps.map((a) => a._id) } }).lean(),
    Interview.find({ application: { $in: apps.map((a) => a._id) }, status: 'scheduled', scheduledDate: { $gte: new Date(Date.now() - 4 * 3600000) } }).sort({ scheduledDate: 1 }).lean()
  ]);
  const byJob = new Map(jobs.map((j) => [String(j._id), j]));
  const empOf = new Map(emps.map((e) => [String(e.application), e]));
  const ivOf = new Map(); for (const i of interviews) if (!ivOf.has(String(i.application))) ivOf.set(String(i.application), i);
  return apps.map((a) => ({ _id: a._id, applicant: a.applicant, status: a.status, offerRequest: a.offerRequest, institutionSelection: a.institutionSelection, resumeSnapshot: a.resumeSnapshot, coverLetter: a.coverLetter, createdAt: a.createdAt,
    job: byJob.get(String(a.job)), agent: byJob.get(String(a.job))?.postedBy?.fullName || '', employment: empOf.get(String(a._id)) || null, nextInterview: ivOf.get(String(a._id)) || null, joining: a.joining }));
}

// The institute picks the candidates its agent may take forward, or turns one down.
async function selectCandidate(user, applicationId, { decision = 'select', note = '' } = {}) {
  if (!oid(applicationId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(applicationId).populate('job').populate('applicant', 'fullName');
  if (!application?.job?.agreement) throw fail('Application not found.', 404);
  await institutionRecruiter(application.job.institution, user);
  if (['hired', 'completed', 'withdrawn'].includes(application.status)) throw fail('This application is already closed.', 409);
  const text = String(note || '').trim().slice(0, 1000);
  if (decision === 'reject') {
    application.status = 'rejected';
    application.statusHistory.push({ status: 'rejected', by: user._id, byRole: 'hiring_organization', note: text || 'Not selected by the institute' });
  } else {
    if (application.institutionSelection?.at) throw fail('Already selected.', 409);
    // 'direct': chosen from the CV, no interview needed; the institute goes on to the offer.
    const direct = decision === 'direct';
    application.institutionSelection = { by: user._id, at: new Date(), note: text, direct };
    if (['pending', 'viewed'].includes(application.status)) application.status = 'shortlisted';
    application.statusHistory.push({ status: application.status, by: user._id, byRole: 'hiring_organization', note: `${direct ? 'Selected by the institute (no interview needed)' : 'Selected by the institute for interview'}${text ? `: ${text}` : ''}` });
  }
  await application.save();
  await notify(application.job.postedBy, { title: decision === 'reject' ? `Not selected by the institute: ${application.applicant.fullName}` : `Selected by the institute: ${application.applicant.fullName}`, body: `${application.job.title}${text ? ` · ${text}` : ''}${decision === 'reject' ? '' : decision === 'direct' ? '. No interview needed: the institute will send the offer to you.' : '. Please interview this candidate.'}`, sentBy: user._id, link: require('../utils/dashLinks').manager(application.job), category: 'recruitment' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  if (decision === 'reject') await notify(application.applicant._id, { title: `${application.job.title} @ ${application.job.company}: Not selected`, body: 'Thank you for applying.', link: require('../utils/dashLinks').candidate('applications'), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  return application;
}

async function invoicesFor(user, { institution } = {}) {
  if (institution) { await institutionRecruiter(institution, user); return RecruitmentInvoice.find({ institution }).sort({ issuedAt: -1 }).lean(); }
  return RecruitmentInvoice.find({ agent: user._id }).populate('institution', 'name').sort({ issuedAt: -1 }).lean();
}
async function invoiceForParty(user, id, { asAdmin = false } = {}) {
  if (!oid(id)) throw fail('Invoice not found.', 404);
  const invoice = await RecruitmentInvoice.findById(id);
  if (!invoice) throw fail('Invoice not found.', 404);
  const isAgent = String(invoice.agent) === String(user._id);
  const institution = await Institution.findById(invoice.institution).select('owner staff');
  const isInstitution = institution && hasStaffPermission(institution, user._id, PERMISSION);
  const isAdmin = asAdmin; // admin routes are already behind the finance department check
  if (!isAgent && !isInstitution && !isAdmin) throw fail('You cannot see this invoice.', 403);
  return { invoice, isAgent, isInstitution, isAdmin };
}
// Where the institute sends the money: always CareerZ's account (Super Admin enters the details).
// CareerZ keeps its service fee and releases the rest to the agent's wallet after verification.
async function paymentInstructions() {
  const { payment } = await feeSettings();
  if (payment.mode === 'platform') return { mode: 'platform', text: payment.instructions || '' };
  return { mode: '', text: '' };
}
async function submitProof(user, id, body = {}) {
  throw fail('Pay this invoice with Pay by bank transfer: the CareerZ service fee first, then the agent\'s share to the agent\'s account.', 410);
  // eslint-disable-next-line no-unreachable
  const { invoice, isInstitution } = await invoiceForParty(user, id);
  if (!isInstitution) throw fail('Only the institute can submit payment proof.', 403);
  if (!['issued', 'more_info_requested'].includes(invoice.status)) throw fail(`This invoice is ${invoice.status.replace(/_/g, ' ')}.`, 409);
  const reference = String(body.reference || '').trim().slice(0, 120);
  if (!reference) throw fail('Enter the bank transfer reference number.');
  const amount = Number(body.amount);
  if (!(amount > 0)) throw fail('Enter the amount you transferred.');
  if (!body.file?.data) throw fail('Attach the bank transfer receipt (PDF or image) so CareerZ can check it.');
  let file = null;
  if (body.file?.data) {
    const PrivateFile = require('../models/PrivateFile');
    const match = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.file.data));
    if (!match) throw fail('Upload the proof as a PDF, PNG, JPG or WEBP file.');
    const data = Buffer.from(match[3], 'base64');
    if (data.length > 3 * 1024 * 1024) throw fail('The proof file must be 3 MB or smaller.');
    file = (await PrivateFile.create({ purpose: 'payment_proof', owner: user._id, filename: String(body.file.name || 'proof').slice(0, 160), mimeType: match[1], size: data.length, data }))._id;
  }
  invoice.proofs.push({ file, reference, amount, paidOn: body.paidOn ? new Date(body.paidOn) : new Date(), submittedBy: user._id });
  invoice.status = 'pending_verification';
  invoice.history.push({ action: 'proof_submitted', by: user._id, note: `Reference ${reference}, amount ${invoice.currency} ${amount}` });
  await invoice.save();
  await notifyAdmins({ title: `Recruitment payment to verify: ${invoice.number}`, body: `${invoice.currency} ${amount}, reference ${reference}.` }).catch(() => {});
  await tellAgent(invoice.agent, { title: `Institute submitted payment for ${invoice.number}`, body: 'An admin will verify the transfer before your earning is released.', link: '/dashboard', sentBy: user._id });
  return invoice;
}
// Admin: approve (money received), reject (back to issued with a reason) or ask for more.
// POST /api/recruitment/invoices/:id/pay-wallet — the institute pays from its CareerZ wallet.
async function payInvoiceFromWallet(user, id) {
  const { invoice, isInstitution } = await invoiceForParty(user, id);
  if (!isInstitution) throw fail('Only the institute can pay this invoice.', 403);
  if (!['issued', 'more_info_requested'].includes(invoice.status)) throw fail(`This invoice is ${invoice.status.replace(/_/g, ' ')}.`, 409);
  await require('./invoiceWallet.service').payFromWallet(invoice, user);
  await tellAgent(invoice.agent, { title: `Payment received: ${invoice.number}`, body: `${invoice.currency} ${invoice.agentEarning} was added to your CareerZ wallet.`, link: '/dashboard', sentBy: user._id });
  return invoice;
}
async function verifyPayment(admin, id, { decision, note }) {
  const { invoice } = await invoiceForParty(admin, id, { asAdmin: true });
  if (invoice.status !== 'pending_verification') throw fail('Only an invoice waiting for verification can be decided.', 409);
  if (!['approve', 'reject', 'more_info'].includes(decision)) throw fail('decision must be approve, reject or more_info.');
  const text = String(note || '').trim().slice(0, 1000);
  if (decision !== 'approve' && !text) throw fail('Write the reason so the institute knows what to do.');
  const walletPaid = Boolean(invoice.wallet?.reference && !invoice.wallet.releasedAt && !invoice.wallet.returnedAt);
  // A bank transfer counts only if the latest proof covers the whole invoice; otherwise ask for more.
  const latestProof = invoice.proofs[invoice.proofs.length - 1];
  if (decision === 'approve' && !walletPaid && !(Number(latestProof?.amount) + 0.01 >= invoice.grossFee)) {
    throw fail(`The proof shows ${invoice.currency} ${Number(latestProof?.amount || 0).toLocaleString()} but the invoice is ${invoice.currency} ${invoice.grossFee.toLocaleString()}. Ask the institute for the rest (more info) instead of approving.`);
  }
  // Claim the decision in one conditional write, so a double-click (or two admins) decides once.
  const next = decision === 'approve' ? 'paid' : decision === 'reject' ? 'issued' : 'more_info_requested';
  const claimed = await RecruitmentInvoice.findOneAndUpdate({ _id: invoice._id, status: 'pending_verification' }, { $set: { status: next } }, { new: true });
  if (!claimed) throw fail('This invoice was already decided.', 409);
  try {
    // Wallet payment: approve releases the money; reject or more-info returns it to the institute.
    if (walletPaid && decision === 'approve') await require('./invoiceWallet.service').release(claimed, admin);
    if (walletPaid && decision !== 'approve') await require('./invoiceWallet.service').returnHeld(claimed, admin, text);
  } catch (error) {
    await RecruitmentInvoice.updateOne({ _id: invoice._id, status: next }, { $set: { status: 'pending_verification' } });
    throw error;
  }
  claimed.history.push({ action: decision === 'approve' ? 'payment_verified' : decision === 'reject' ? 'payment_rejected' : 'more_info_requested', by: admin._id, note: text });
  await claimed.save();
  if (decision === 'approve') {
    // Wallet payment: the agent's share is already in their wallet, so the commission is settled.
    await Commission.updateOne({ _id: invoice.commission, status: 'pending' }, { $set: { status: walletPaid ? 'paid' : 'available' } });
    await tellAgent(invoice.agent, { title: `Payment verified: ${invoice.number}`, body: walletPaid ? `${invoice.currency} ${invoice.agentEarning} was added to your CareerZ wallet.` : `Your earning of ${invoice.currency} ${invoice.agentEarning} is available to withdraw.`, link: '/dashboard', sentBy: admin._id });
  }
  await tellInstitution(invoice.institution, { title: decision === 'approve' ? `Payment received: ${invoice.number}` : `Payment not verified: ${invoice.number}`, body: text || 'Thank you.', link: '/dashboard', sentBy: admin._id });
  return claimed;
}
async function proofFile(user, invoiceId, proofId, asAdmin = false) {
  const { invoice } = await invoiceForParty(user, invoiceId, { asAdmin });
  const proof = invoice.proofs.id(proofId);
  if (!proof?.file) throw fail('File not found.', 404);
  return require('../models/PrivateFile').findById(proof.file);
}

// ---------------------------------------------------------------- replacement / refund review
async function reportLeft(user, invoiceId, reason) {
  const { invoice, isInstitution } = await invoiceForParty(user, invoiceId);
  if (!isInstitution) throw fail('Only the institute can report that a hire left.', 403);
  if (invoice.replacement?.status && !['', 'replaced'].includes(invoice.replacement.status)) throw fail('This hire is already being reviewed.', 409);
  const text = String(reason || '').trim().slice(0, 1000);
  if (!text) throw fail('Say when and why the person left.');
  const agreement = await RecruitmentAgreement.findById(invoice.agreement);
  const commission = await Commission.findById(invoice.commission);
  const app = !commission ? null : commission.guestApplication ? await GuestApplication.findById(commission.guestApplication).select('joining') : await JobApplication.findById(commission.application).select('joining');
  const joinedAt = app?.joining?.confirmedAt || invoice.issuedAt;
  const rep = agreement?.replacement || {};
  const within = rep.periodDays && Date.now() - new Date(joinedAt).getTime() <= rep.periodDays * 864e5;
  const attemptsLeft = !rep.attempts || (invoice.replacement?.attemptsUsed || 0) < rep.attempts;
  invoice.replacement = { ...(invoice.replacement?.toObject?.() || {}), reportedAt: new Date(), reportedBy: user._id, reason: text,
    status: within && attemptsLeft ? 'awaiting_replacement' : 'refund_review', deadline: within && attemptsLeft ? new Date(Date.now() + rep.deadlineDays * 864e5) : null };
  invoice.history.push({ action: 'hire_left_reported', by: user._id, note: text });
  await invoice.save();
  if (invoice.replacement.status === 'awaiting_replacement') await tellAgent(invoice.agent, { title: `Replacement needed: ${invoice.number}`, body: `The hire left within the agreed period. Provide a replacement by ${invoice.replacement.deadline.toDateString()}.`, link: '/dashboard', sentBy: user._id });
  else await notifyAdmins({ title: `Recruitment refund review: ${invoice.number}`, body: text }).catch(() => {});
  return invoice;
}
// Institute marks the replacement done (the replacement hire is confirmed separately and is free).
async function replacementDone(user, invoiceId, note) {
  const { invoice, isInstitution } = await invoiceForParty(user, invoiceId);
  if (!isInstitution) throw fail('Only the institute can confirm a replacement.', 403);
  if (invoice.replacement?.status !== 'awaiting_replacement') throw fail('No replacement is pending.', 409);
  invoice.replacement.status = 'replaced';
  invoice.replacement.attemptsUsed = (invoice.replacement.attemptsUsed || 0) + 1;
  invoice.replacement.resolutionNote = String(note || '').slice(0, 1000);
  invoice.replacement.resolvedBy = user._id; invoice.replacement.resolvedAt = new Date();
  invoice.history.push({ action: 'replacement_provided', by: user._id, note: invoice.replacement.resolutionNote });
  await invoice.save();
  await tellAgent(invoice.agent, { title: `Replacement accepted: ${invoice.number}`, link: '/dashboard', sentBy: user._id });
  return invoice;
}
// Escalate to admin when the deadline passed without a replacement (either side may ask).
async function escalate(user, invoiceId, note) {
  const { invoice, isAgent, isInstitution } = await invoiceForParty(user, invoiceId);
  if (!isAgent && !isInstitution) throw fail('Only the institute or the agent can ask for a review.', 403);
  if (invoice.replacement?.status !== 'awaiting_replacement') throw fail('Nothing to escalate.', 409);
  if (isInstitution && invoice.replacement.deadline && new Date() < invoice.replacement.deadline) throw fail('The replacement deadline has not passed yet.', 409);
  invoice.replacement.status = 'refund_review';
  invoice.history.push({ action: 'escalated_to_admin', by: user._id, note: String(note || '').slice(0, 1000) });
  await invoice.save();
  await notifyAdmins({ title: `Recruitment refund review: ${invoice.number}`, body: String(note || 'Replacement deadline passed.') }).catch(() => {});
  return invoice;
}
// Admin's decision. A refund or adjustment is recorded; money moves outside the platform.
async function resolveReview(admin, invoiceId, { outcome, note }) {
  const { invoice } = await invoiceForParty(admin, invoiceId, { asAdmin: true });
  if (invoice.replacement?.status !== 'refund_review') throw fail('This invoice is not under refund review.', 409);
  if (!['refunded', 'adjusted', 'dismissed'].includes(outcome)) throw fail('outcome must be refunded, adjusted or dismissed.');
  const text = String(note || '').trim().slice(0, 1000);
  if (!text) throw fail('Record the decision and the amount, if any.');
  Object.assign(invoice.replacement, { status: outcome, resolutionNote: text, resolvedBy: admin._id, resolvedAt: new Date() });
  invoice.history.push({ action: `review_${outcome}`, by: admin._id, note: text });
  if (outcome === 'refunded') {
    if (invoice.status !== 'paid') invoice.status = 'cancelled';
    // Paid straight to the agent's bank (not a CareerZ wallet): the refund is the agent's to return, so the earning is cancelled too.
    await Commission.updateOne({ _id: invoice.commission, status: { $in: invoice.wallet?.reference ? ['pending', 'approved', 'available'] : ['pending', 'approved', 'available', 'paid'] } }, { $set: { status: 'cancelled' } });
  }
  await invoice.save();
  const payload = { title: `Recruitment review decided: ${invoice.number}`, body: `${outcome}: ${text}`, link: '/dashboard', sentBy: admin._id };
  await tellAgent(invoice.agent, payload); await tellInstitution(invoice.institution, payload);
  return invoice;
}

module.exports = {
  listAgents, saveAgentProfile, createRequest, listRequests, respond, addMessage, cancelRequest,
  proposeTerms, acceptTerms, declineTerms, endAgreement, agreementsOf, publishingAuthority,
  hiresForInstitution, candidatesForInstitution, selectCandidate, payInvoiceFromWallet, confirmHire, declineHire, invoicesFor, invoiceForParty, paymentInstructions, submitProof, verifyPayment, proofFile,
  reportLeft, replacementDone, escalate, resolveReview, feeSettings, tellInstitution, PLATFORM_FEE_KEY, PAYMENT_KEY
};
