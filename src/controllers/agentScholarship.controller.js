const mongoose = require('mongoose');
const Scholarship = require('../models/Scholarship');
const ScholarshipApplication = require('../models/ScholarshipApplication');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify, notifyAdmins } = require('../services/notification.service');
const { onScholarshipPublished } = require('../services/scholarshipAlerts.service');

// Scholarships an Agent publishes for a provider. Publishing is a listing service only: the agent
// never awards or funds. With a CareerZ Donor as provider, the donor confirms the listing first
// and applications come in on CareerZ for the donor to decide; with any other provider the
// listing links out to the provider's own application page. Every agent listing is approved by
// an admin before it goes live, and goes back to review when its content changes.

const PROVIDER_TYPES = ['careerz_donor', 'university', 'government', 'foundation', 'company', 'other'];
const CONTENT = ['title', 'description', 'amount', 'currency', 'eligibilityCriteria', 'country', 'applicationDeadline', 'seatsAvailable', 'audience', 'externalUrl'];
const fail = (m, c = 422) => new AppError(m, c);

async function assertAgent(user) {
  if (!(await isRoleVerified(user._id, 'education_agent'))) throw fail('Only verified Agents can publish scholarships for providers.', 403);
}
function clean(body, existing = {}) {
  const out = {};
  CONTENT.forEach((f) => { if (body[f] !== undefined) out[f] = body[f]; });
  if (out.audience !== undefined) {
    out.audience = [...new Set((Array.isArray(out.audience) ? out.audience : [out.audience]).filter((a) => ['students', 'teachers'].includes(a)))];
    if (!out.audience.length) out.audience = ['students'];
  }
  const merged = { ...existing, ...out };
  if (!String(merged.title || '').trim()) throw fail('Enter the scholarship title.');
  if (!(Number(merged.amount) >= 0)) throw fail('Enter the scholarship amount (0 when it varies).');
  return out;
}
function cleanProvider(p = {}) {
  const provider = { type: p.type, name: String(p.name || '').trim().slice(0, 160), website: String(p.website || '').trim().slice(0, 300), country: String(p.country || '').slice(0, 80),
    authorization: String(p.authorization || '').trim().slice(0, 2000), donor: null };
  if (!PROVIDER_TYPES.includes(provider.type)) throw fail('Choose the provider type.');
  if (provider.type !== 'careerz_donor' && !provider.name) throw fail('Enter the provider name.');
  if (provider.website && !/^https:\/\/[^\s]+$/i.test(provider.website)) throw fail('The provider website must start with https://');
  if (provider.authorization.length < 20) throw fail('Explain how the provider authorized you to publish this scholarship (at least 20 characters).');
  return provider;
}
const httpsUrl = (u) => /^https:\/\/[^\s]+$/i.test(String(u || ''));
// After the donor (if any) has confirmed: open at once unless the automatic check holds it.
async function autoOpen(s, by) {
  const { flags, held } = require('../services/autoModeration.service').checkScholarship(s);
  if (held) {
    s.status = 'pending_review';
    s.review = { ...(s.review?.toObject?.() || s.review || {}), status: 'pending', note: flags.map((f) => f.label).join('; ') };
    await notifyAdmins({ title: `Scholarship listing held for review: ${s.title}`, body: s.review.note }).catch(() => {});
  } else {
    s.status = 'open';
    s.review = { ...(s.review?.toObject?.() || s.review || {}), status: 'approved', note: 'Passed the automatic check', reviewedBy: null, reviewedAt: new Date() };
  }
  return held;
}
// Once open (saved): students are alerted, the agent and the donor are told.
async function afterOpen(s) {
  if (s.status !== 'open') return;
  await onScholarshipPublished(s);
  await notify(s.publishedBy, { title: `Scholarship published: ${s.title}`, link: `/scholarships/${s._id}`, category: 'scholarship' }).catch(() => {});
  if (s.donor) await notify(s.donor, { title: `Scholarship published: ${s.title}`, body: 'Applications will reach you in Scholarships.', link: require('../utils/dashLinks').donorScholarships, category: 'scholarship' }).catch(() => {});
}

// POST /api/scholarships/agent
const create = asyncHandler(async (req, res) => {
  await assertAgent(req.user);
  const body = clean(req.body || {});
  const provider = cleanProvider(req.body?.provider);
  const doc = { ...body, publishedBy: req.user._id, provider, status: 'pending_review' };
  if (provider.type === 'careerz_donor') {
    const donorId = req.body?.provider?.donor;
    if (!mongoose.isValidObjectId(donorId) || !(await isRoleVerified(donorId, 'donor'))) throw fail('Choose a verified CareerZ Donor as the provider.');
    const donor = await require('../models/User').findById(donorId).select('fullName status');
    if (donor?.status !== 'active') throw fail('That donor account is not active.');
    doc.donor = donor._id;
    doc.provider.donor = donor._id;
    doc.provider.name = doc.provider.name || donor.fullName;
    doc.applicationMode = 'internal';
    doc.externalUrl = '';
    doc.review = { status: 'awaiting_donor' };
  } else {
    if (!httpsUrl(body.externalUrl)) throw fail('Enter the provider\'s application page (https://…). Applicants apply there.');
    doc.donor = null;
    doc.applicationMode = 'external';
    doc.review = { status: 'pending' };
  }
  const scholarship = new Scholarship(doc);
  if (!doc.donor) await autoOpen(scholarship, null);
  await scholarship.save();
  await afterOpen(scholarship);
  if (doc.donor) await notify(doc.donor, { title: `Confirm a scholarship listing: ${scholarship.title}`, body: `${req.user.fullName} (Agent) wants to list this scholarship with you as the provider. You decide applications and fund awards; confirm only if you agreed to it.`, sentBy: req.user._id, link: require('../utils/dashLinks').donorScholarships, category: 'scholarship' }, { email: true }).catch(() => {});
  return created(res, scholarship, doc.donor ? 'Sent to the donor to confirm. It goes live once they confirm.' : scholarship.status === 'open' ? 'Your scholarship listing is live.' : 'Our automatic check wants a CareerZ admin to look at this listing first.');
});

// GET /api/scholarships/agent/mine — with application counts only (applicants are the donor's).
const mine = asyncHandler(async (req, res) => {
  const list = await Scholarship.find({ publishedBy: req.user._id }).sort({ createdAt: -1 }).lean();
  const counts = await ScholarshipApplication.aggregate([{ $match: { scholarship: { $in: list.map((s) => s._id) } } }, { $group: { _id: '$scholarship', n: { $sum: 1 } } }]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  return ok(res, list.map((s) => ({ ...s, applicationCount: byId.get(String(s._id)) || 0 })));
});

// PATCH /api/scholarships/agent/:id — edit (back to review) or close.
const update = asyncHandler(async (req, res) => {
  const s = mongoose.isValidObjectId(req.params.id) ? await Scholarship.findById(req.params.id) : null;
  if (!s || String(s.publishedBy) !== String(req.user._id)) throw fail('Scholarship not found.', 404);
  if (s.status === 'removed_by_admin') throw fail(`CareerZ admin removed this: ${s.adminRemoval?.reason || 'it broke the rules'}. Contact support if you think this is wrong.`, 403);
  if (req.body?.status === 'closed') {
    s.status = 'closed';
    await s.save();
    return ok(res, s, 'Scholarship closed.');
  }
  await assertAgent(req.user);
  const changes = clean(req.body || {}, s.toObject());
  if (s.applicationMode === 'external' && changes.externalUrl !== undefined && !httpsUrl(changes.externalUrl)) throw fail('The application page must start with https://');
  if (s.applicationMode === 'internal') delete changes.externalUrl;
  if (!Object.keys(changes).length) throw fail('Nothing to change.');
  const wasOpen = s.status === 'open';
  Object.assign(s, changes);
  if (s.donor) { s.status = 'pending_review'; s.review = { status: 'awaiting_donor' }; } else await autoOpen(s, null);
  await s.save();
  if (!wasOpen) await afterOpen(s);
  if (s.donor) await notify(s.donor, { title: `Scholarship listing changed, confirm again: ${s.title}`, sentBy: req.user._id, link: require('../utils/dashLinks').donorScholarships, category: 'scholarship' }).catch(() => {});
  return ok(res, s, s.donor ? 'Changes sent to the donor to confirm.' : s.status === 'open' ? 'Changes saved; the listing is live.' : 'Our automatic check wants a CareerZ admin to look at the changes.');
});

// POST /api/scholarships/:id/donor-confirm { decision: 'confirm' | 'decline', note }
const donorConfirm = asyncHandler(async (req, res) => {
  const s = mongoose.isValidObjectId(req.params.id) ? await Scholarship.findById(req.params.id) : null;
  if (!s || !s.publishedBy || String(s.donor) !== String(req.user._id)) throw fail('Scholarship not found.', 404);
  if (s.review?.status !== 'awaiting_donor') throw fail('This listing is not waiting for your confirmation.', 409);
  const decision = req.body?.decision;
  if (!['confirm', 'decline'].includes(decision)) throw fail('decision must be confirm or decline.');
  if (decision === 'confirm') {
    s.review = { status: 'pending', donorConfirmedAt: new Date() };
    await autoOpen(s, null);
  } else {
    s.status = 'rejected';
    s.review = { status: 'rejected', note: `Declined by the donor. ${String(req.body?.note || '').slice(0, 500)}`.trim(), reviewedAt: new Date() };
  }
  await s.save();
  await afterOpen(s);
  await notify(s.publishedBy, { title: decision === 'confirm' ? `Donor confirmed: ${s.title}` : `Donor declined: ${s.title}`, body: decision === 'confirm' ? (s.status === 'open' ? 'It is live now.' : 'Our automatic check wants a CareerZ admin to look at it.') : String(req.body?.note || ''), sentBy: req.user._id, link: require('../utils/dashLinks').agentScholarships, category: 'scholarship' }).catch(() => {});
  return ok(res, s, decision === 'confirm' ? (s.status === 'open' ? 'Confirmed. The listing is live.' : 'Confirmed. A CareerZ admin will look at it first.') : 'Declined.');
});

// Admin: GET /api/admin/scholarships/review, POST /api/admin/scholarships/:id/decision
const reviewQueue = asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const list = await Scholarship.find({ publishedBy: { $ne: null }, 'review.status': status }).populate('publishedBy', 'fullName email').populate('donor', 'fullName email').sort({ updatedAt: -1 }).limit(200).lean();
  return ok(res, list);
});
const decide = asyncHandler(async (req, res) => {
  const s = mongoose.isValidObjectId(req.params.id) ? await Scholarship.findById(req.params.id) : null;
  if (!s || !s.publishedBy) throw fail('Scholarship not found.', 404);
  if (s.review?.status !== 'pending') throw fail('This listing is not waiting for review.', 409);
  const decision = req.body?.decision;
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!['approve', 'reject'].includes(decision)) throw fail('decision must be approve or reject.');
  if (decision === 'reject' && !note) throw fail('Write the reason so the agent can fix it.');
  s.review = { ...s.review.toObject(), status: decision === 'approve' ? 'approved' : 'rejected', note, reviewedBy: req.user._id, reviewedAt: new Date() };
  s.status = decision === 'approve' ? 'open' : 'rejected';
  await s.save();
  if (decision === 'approve') await onScholarshipPublished(s);
  await notify(s.publishedBy, { title: decision === 'approve' ? `Scholarship published: ${s.title}` : `Scholarship not approved: ${s.title}`, body: note, sentBy: req.user._id, link: decision === 'approve' ? `/scholarships/${s._id}` : '/dashboard', category: 'scholarship' }, { email: true }).catch(() => {});
  if (s.donor && decision === 'approve') await notify(s.donor, { title: `Scholarship published: ${s.title}`, body: 'Applications will reach you in Scholarships.', sentBy: req.user._id, link: require('../utils/dashLinks').donorScholarships, category: 'scholarship' }).catch(() => {});
  return ok(res, s, decision === 'approve' ? 'Published.' : 'Rejected.');
});

module.exports = { create, mine, update, donorConfirm, reviewQueue, decide, PROVIDER_TYPES };
