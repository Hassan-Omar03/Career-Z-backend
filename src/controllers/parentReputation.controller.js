const Institution = require('../models/Institution');
const ParentTeacherMeeting = require('../models/ParentTeacherMeeting');
const ParentChildLink = require('../models/ParentChildLink');
const ParentPermission = require('../models/ParentPermission');
const Notification = require('../models/Notification');
const Fee = require('../models/Fee');
const InstitutionFeedback = require('../models/InstitutionFeedback');
const StudentProfile = require('../models/StudentProfile');
const ReputationDispute = require('../models/ReputationDispute');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

const ROLLING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 12 months — recent activity weighted, per spec

// Private, non-punitive engagement indicator (spec 11.15) — every input below is a real record
// the parent actually generated, never invented. Nothing here can reject an admission, suspend
// an account, or leave the pair (institution, parent) it's scoped to — see the route-level
// authorization in the controller functions.
async function computeReputation(institutionId, parentId) {
  const since = new Date(Date.now() - ROLLING_WINDOW_MS);
  const excludedIds = await ReputationDispute.find({ parent: parentId, institution: institutionId, status: 'upheld' }).distinct('referenceId');
  const excludedSet = new Set(excludedIds.map((id) => id.toString()));

  const childIds = await ParentChildLink.find({ parent: parentId, status: 'approved' }).distinct('student');
  const childIdsAtInstitution = await StudentProfile.find({ user: { $in: childIds }, primaryInstitution: institutionId }).distinct('user');

  // 30% — PTM attendance: completed vs. every PTM that actually reached a real outcome
  // (declined/completed), excluding ones still pending/upcoming (not yet a real signal).
  const ptms = await ParentTeacherMeeting.find({
    parent: parentId, institution: institutionId, status: { $in: ['completed', 'declined', 'cancelled'] }, createdAt: { $gte: since }
  });
  const ptmCounted = ptms.filter((p) => !excludedSet.has(p._id.toString()));
  const ptmScore = ptmCounted.length > 0 ? (ptmCounted.filter((p) => p.status === 'completed').length / ptmCounted.length) * 100 : null;

  // 25% — consent responsiveness: ParentChildLink is the platform's real "awaiting parent
  // decision" mechanism. Scored on links where the parent was NOT the requester (i.e. someone
  // else's request the parent had to actually respond to), by how quickly they resolved it.
  const consentLinks = await ParentChildLink.find({
    parent: parentId, requestedBy: { $ne: parentId }, status: { $in: ['approved', 'rejected'] }, createdAt: { $gte: since }
  });
  const consentCounted = consentLinks.filter((l) => !excludedSet.has(l._id.toString()));
  const consentScore = consentCounted.length > 0
    ? (consentCounted.filter((l) => {
        const hours = (new Date(l.approvedAt || l.updatedAt) - l.createdAt) / 3600000;
        return hours <= 72; // responded within 3 days counts as "on time"
      }).length / consentCounted.length) * 100
    : null;

  // 20% — institution messages/notices acknowledgement: read rate of notifications actually
  // sent by this institution's own owner/staff (not platform-wide notices).
  const institution = await Institution.findById(institutionId);
  const senderIds = institution ? [institution.owner, ...institution.staff.map((s) => s.user)].map(String) : [];
  const notifications = await Notification.find({ user: parentId, sentBy: { $in: senderIds }, createdAt: { $gte: since } });
  const notifCounted = notifications.filter((n) => !excludedSet.has(n._id.toString()));
  const notifScore = notifCounted.length > 0 ? (notifCounted.filter((n) => n.read).length / notifCounted.length) * 100 : null;

  // 15% — fee communication/resolution: lenient by design (spec: financial difficulty/lateness
  // is never treated as misconduct) — scores whether the fee reached a resolved state
  // (paid or a refund was requested/handled), not whether it was paid ON TIME.
  const fees = await Fee.find({ student: { $in: childIdsAtInstitution }, institution: institutionId, createdAt: { $gte: since } });
  const feeCounted = fees.filter((f) => !excludedSet.has(f._id.toString()));
  const feeScore = feeCounted.length > 0
    ? (feeCounted.filter((f) => f.status === 'paid' || f.status === 'refunded' || f.refund?.status !== 'none').length / feeCounted.length) * 100
    : null;

  // 10% — constructive participation: real, verified InstitutionFeedback left by this parent.
  const feedback = await InstitutionFeedback.findOne({ institution: institutionId, fromUser: parentId });
  const feedbackScore = feedback ? (feedback.comment?.trim() ? 100 : 60) : null;

  const components = [
    { key: 'ptmAttendance', weight: 0.30, score: ptmScore, count: ptmCounted.length },
    { key: 'consentResponsiveness', weight: 0.25, score: consentScore, count: consentCounted.length },
    { key: 'notificationAcknowledgement', weight: 0.20, score: notifScore, count: notifCounted.length },
    { key: 'feeResolution', weight: 0.15, score: feeScore, count: feeCounted.length },
    { key: 'participation', weight: 0.10, score: feedbackScore, count: feedback ? 1 : 0 }
  ];

  // Only weight the components that actually have data — a parent with zero PTMs at this
  // institution isn't punished for it, the remaining components are re-normalized instead.
  const withData = components.filter((c) => c.score !== null);
  const totalWeight = withData.reduce((sum, c) => sum + c.weight, 0);
  const overall = totalWeight > 0
    ? Math.round(withData.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight)
    : null;

  const label = overall === null ? 'Not enough data yet' : overall >= 70 ? 'Highly engaged' : overall >= 40 ? 'Engaged' : 'Needs contact';

  return { overall, label, components, windowDays: 365 };
}

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  if (isOwner) return true;
  return institution.staff.some((s) => s.user.toString() === userId.toString());
}

// GET /api/parent-reputation/:institutionId/:parentId — visible only to the institution
// (owner/staff) or the parent themselves (spec: "Score sirf linked institution aur parent ko
// nazar aaye" — never the student, never a public profile, never an unrelated institution).
const getReputation = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);

  const isSelf = req.params.parentId === req.user._id.toString();
  const isInstitutionSide = assertOwnerOrStaff(institution, req.user._id);
  if (!isSelf && !isInstitutionSide) throw new AppError('You do not have access to this reputation score.', 403);

  const data = await computeReputation(req.params.institutionId, req.params.parentId);
  return ok(res, data);
});

// GET /api/parent-reputation/mine — a parent's own scores across every institution their
// children are enrolled at.
const myReputationSummary = asyncHandler(async (req, res) => {
  const childIds = await ParentChildLink.find({ parent: req.user._id, status: 'approved' }).distinct('student');
  const institutionIds = await StudentProfile.find({ user: { $in: childIds } }).distinct('primaryInstitution');
  const results = await Promise.all(institutionIds.filter(Boolean).map(async (instId) => {
    const institution = await Institution.findById(instId).select('name');
    return { institution: { _id: instId, name: institution?.name }, ...(await computeReputation(instId, req.user._id)) };
  }));
  return ok(res, results);
});

// POST /api/parent-reputation/disputes — parent disputes one specific input.
const submitDispute = asyncHandler(async (req, res) => {
  const { institutionId, category, referenceId, reason } = req.body;
  if (!institutionId || !category || !referenceId || !reason?.trim()) {
    throw new AppError('institutionId, category, referenceId and reason are required.', 422);
  }
  if (!['ptm', 'consent', 'notifications', 'fees'].includes(category)) throw new AppError('Invalid category.', 422);

  const dispute = await ReputationDispute.create({ parent: req.user._id, institution: institutionId, category, referenceId, reason: reason.trim() });
  const institution = await Institution.findById(institutionId);
  if (institution) await notify(institution.owner, { title: 'Reputation score dispute submitted', body: reason.trim(), sentBy: req.user._id }).catch(() => {});
  return created(res, dispute, 'Dispute submitted for review.');
});

// GET /api/parent-reputation/disputes/:institutionId — institution's review queue.
const listDisputes = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (!assertOwnerOrStaff(institution, req.user._id)) throw new AppError('You do not have access to this institution\'s disputes.', 403);

  const disputes = await ReputationDispute.find({ institution: institution._id }).populate('parent', 'fullName email').sort({ createdAt: -1 });
  return ok(res, disputes);
});

// PATCH /api/parent-reputation/disputes/:id/resolve
const resolveDispute = asyncHandler(async (req, res) => {
  const { decision, note } = req.body;
  if (!['upheld', 'rejected'].includes(decision)) throw new AppError('decision must be upheld or rejected.', 422);

  const dispute = await ReputationDispute.findById(req.params.id);
  if (!dispute) throw new AppError('Dispute not found.', 404);
  const institution = await Institution.findById(dispute.institution);
  if (!institution || !assertOwnerOrStaff(institution, req.user._id)) throw new AppError('You do not have access to this dispute.', 403);
  if (dispute.status !== 'pending') throw new AppError('This dispute has already been resolved.', 400);

  dispute.status = decision;
  dispute.resolvedBy = req.user._id;
  dispute.resolvedAt = new Date();
  dispute.resolutionNote = note || '';
  await dispute.save();

  await notify(dispute.parent, { title: `Your reputation dispute was ${decision}`, body: dispute.resolutionNote, sentBy: req.user._id }).catch(() => {});
  return ok(res, dispute, `Dispute ${decision}.`);
});

module.exports = { getReputation, myReputationSummary, submitDispute, listDisputes, resolveDispute };
