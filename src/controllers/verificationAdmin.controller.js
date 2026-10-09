const RoleRequest = require('../models/RoleRequest');
const User = require('../models/User');
const UserProfile = require('../models/UserProfile');
const VerificationDocument = require('../models/VerificationDocument');
const VerificationHistory = require('../models/VerificationHistory');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { decrypt } = require('../utils/encryption');
const cfg = require('../config/accountVerification');
const service = require('../services/accountVerification.service');

const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/verifications?status=&role=&q=&page=
const list = asyncHandler(async (req, res) => {
  const filter = { requestedRole: { $in: cfg.VERIFIED_ROLES } };
  const status = String(req.query.status || 'open');
  if (status === 'open') filter.status = { $in: ['pending', 'pending_approval', 'under_review'] };
  else if (status !== 'all') filter.status = status === 'pending_approval' ? { $in: ['pending', 'pending_approval'] } : status;
  if (req.query.role) filter.requestedRole = String(req.query.role);
  if (req.query.q) {
    const re = new RegExp(escape(req.query.q), 'i');
    const users = await User.find({ $or: [{ fullName: re }, { email: re }, { phone: re }] }).select('_id').limit(500);
    filter.user = { $in: users.map((u) => u._id) };
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const [rows, total] = await Promise.all([
    RoleRequest.find(filter).populate('user', 'fullName email phone createdAt').sort({ submittedAt: 1, createdAt: 1 }).skip((page - 1) * 50).limit(50).lean(),
    RoleRequest.countDocuments(filter)
  ]);
  const docCounts = await VerificationDocument.aggregate([{ $match: { active: true, user: { $in: rows.map((r) => r.user?._id).filter(Boolean) } } }, { $group: { _id: { user: '$user', role: '$role' }, count: { $sum: 1 } } }]);
  const countOf = new Map(docCounts.map((d) => [`${d._id.user}:${d._id.role}`, d.count]));
  return ok(res, {
    total, page,
    rows: rows.filter((r) => r.user).map((r) => ({
      _id: r._id, userId: r.user._id, name: r.user.fullName, email: r.user.email, phone: r.user.phone || '', role: r.requestedRole, accountType: cfg.ROLE_LABEL[r.requestedRole] || r.requestedRole,
      subtype: r.subtype, registeredAt: r.user.createdAt, submittedAt: r.submittedAt, status: r.status === 'pending' ? 'pending_approval' : r.status, documents: countOf.get(`${r.user._id}:${r.requestedRole}`) || 0, legacy: r.legacy
    }))
  });
});

// GET /api/admin/verifications/:id — everything needed to decide.
const detail = asyncHandler(async (req, res) => {
  const request = await RoleRequest.findById(req.params.id).populate('user', 'fullName email phone createdAt roles status').populate('reviewedBy', 'fullName');
  if (!request) throw new AppError('Verification request not found.', 404);
  const userId = request.user._id;
  const [documents, profile, history] = await Promise.all([
    VerificationDocument.find({ user: userId, role: request.requestedRole }).sort({ active: -1, createdAt: -1 }).lean(),
    UserProfile.findOne({ user: userId, role: request.requestedRole }).lean(),
    VerificationHistory.find({ user: userId, role: request.requestedRole }).populate('admin', 'fullName').sort({ createdAt: -1 }).lean()
  ]);
  // Same file submitted by a different account is a fraud signal worth showing.
  const shared = await VerificationDocument.find({ sha256: { $in: documents.map((d) => d.sha256) }, user: { $ne: userId } }).populate('user', 'fullName email').lean();
  const sharedBy = new Map(); shared.forEach((d) => { if (!sharedBy.has(d.sha256)) sharedBy.set(d.sha256, []); sharedBy.get(d.sha256).push(d.user ? `${d.user.fullName} (${d.user.email})` : 'another account'); });
  const fields = cfg.profileFields(request.requestedRole, request.subtype).map((f) => ({
    key: f.key, label: f.label, required: f.required,
    value: f.sensitive ? (profile?.sensitive?.[f.key]?.encrypted ? decrypt(profile.sensitive[f.key].encrypted) : '') : (profile?.fields?.[f.key] ?? '')
  }));
  return ok(res, {
    request: { ...request.toObject(), status: request.status === 'pending' ? 'pending_approval' : request.status, accountType: cfg.ROLE_LABEL[request.requestedRole] },
    requirements: service.evaluateDocuments(request.requestedRole, request.subtype, documents.filter((d) => d.active)),
    documents: documents.map((d) => ({ _id: d._id, documentType: d.documentType, label: cfg.DOCUMENT_TYPES[d.documentType] || d.documentType, contentType: d.contentType, size: d.size, active: d.active, verificationStatus: d.verificationStatus, rejectionReason: d.rejectionReason, createdAt: d.createdAt, replacedAt: d.replacedAt, alsoUsedBy: sharedBy.get(d.sha256) || [] })),
    profile: { completed: Boolean(profile?.completed), percent: profile?.percent || 0, fields },
    history,
    actions: Object.entries(service.ACTIONS).filter(([, r]) => r.from.includes(request.status === 'pending' ? 'pending_approval' : request.status)).map(([k]) => k),
    documentTypes: [...cfg.allowedDocumentTypes(request.requestedRole, request.subtype)].map((t) => ({ type: t, label: cfg.DOCUMENT_TYPES[t] }))
  });
});

// POST /api/admin/verifications/:id/decision — { action, reason, documents }
const decision = asyncHandler(async (req, res) => {
  const request = await service.decide({ requestId: req.params.id, admin: req.user, action: String(req.body?.action || ''), reason: req.body?.reason, documents: req.body?.documents, meta: { method: req.method, path: req.originalUrl, ip: req.ip } });
  return ok(res, request, `Account ${request.status.replace('_', ' ')}.`);
});

module.exports = { list, detail, decision };
