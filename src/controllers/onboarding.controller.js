const RoleRequest = require('../models/RoleRequest');
const VerificationHistory = require('../models/VerificationHistory');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const cfg = require('../config/accountVerification');
const service = require('../services/accountVerification.service');
const { gateFor, normalize } = require('../services/accountGate.service');

// GET /api/onboarding/requirements — public: what each account type submits and fills in.
const requirements = asyncHandler(async (req, res) => {
  const out = Object.entries(cfg.ACCOUNT_TYPES).map(([accountType, { role, label }]) => {
    const subtypes = cfg.SUBTYPES[role] || [''];
    return {
      accountType, role, label, subtypes: cfg.SUBTYPES[role] || [],
      bySubtype: Object.fromEntries(subtypes.map((s) => [s || 'default', {
        documents: cfg.documentRequirements(role, s).map((g) => ({ label: g.label, mandatory: g.mandatory !== false, options: g.anyOf.map((set) => set.map((t) => ({ type: t, label: cfg.DOCUMENT_TYPES[t], imageOnly: cfg.IMAGE_ONLY.has(t) }))) })),
        profileFields: cfg.profileFields(role, s).map(({ key, label, required, type, options }) => ({ key, label, required, type, options }))
      }]))
    };
  });
  return ok(res, { accountTypes: out, limits: { imageMb: service.MAX_IMAGE_BYTES / 1048576, pdfMb: service.MAX_PDF_BYTES / 1048576 } });
});

// GET /api/onboarding/status — the caller's verification + profile state for every account type.
const status = asyncHandler(async (req, res) => {
  const gate = req.accountGate || await gateFor(req.user);
  return ok(res, await service.statusFor(req.user, gate));
});

// POST /api/onboarding/account-types — { accountType, subtype } adds another account type.
const addAccountType = asyncHandler(async (req, res) => {
  const role = cfg.roleFor(req.body?.accountType);
  if (!role) throw new AppError('Choose a valid account type.', 422);
  const subtype = String(req.body?.subtype || '');
  if (cfg.SUBTYPES[role] && subtype && !cfg.SUBTYPES[role].includes(subtype)) throw new AppError('Choose a valid account kind.', 422);
  if (req.user.roles.includes(role) && await RoleRequest.exists({ user: req.user._id, requestedRole: role })) throw new AppError('You already have this account type.', 409);
  req.user.roles = Array.from(new Set([...req.user.roles, role]));
  await req.user.save();
  const request = await RoleRequest.create({ user: req.user._id, requestedRole: role, subtype: subtype || (cfg.SUBTYPES[role]?.[0] || ''), status: 'awaiting_documents' });
  await VerificationHistory.create({ user: req.user._id, role, request: request._id, previousStatus: '', newStatus: 'awaiting_documents', remarks: 'Account type added.' });
  return created(res, request, `${cfg.ROLE_LABEL[role]} account added. Upload the required documents next.`);
});

// PATCH /api/onboarding/account-types/:role — { subtype } before approval (e.g. individual → organization).
const setSubtype = asyncHandler(async (req, res) => {
  const role = req.params.role;
  const subtype = String(req.body?.subtype || '');
  if (!cfg.SUBTYPES[role]?.includes(subtype)) throw new AppError('Choose a valid account kind.', 422);
  const request = await RoleRequest.findOne({ user: req.user._id, requestedRole: role }).sort({ createdAt: -1 });
  if (!request) throw new AppError('Account type not found.', 404);
  if (['approved', 'suspended', 'pending_approval', 'under_review'].includes(normalize(request.status))) throw new AppError('This can only be changed before you submit your documents.', 409);
  request.subtype = subtype;
  await request.save();
  return ok(res, request, 'Saved.');
});

// POST /api/onboarding/documents?role=&type=  (raw file body; Content-Type: the file's type)
const uploadDocument = asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new AppError('Send the file as the request body.', 422);
  const result = await service.uploadDocument({ user: req.user, role: String(req.query.role || ''), documentType: String(req.query.type || ''), buffer: req.body, originalName: decodeURIComponent(String(req.headers['x-file-name'] || '')) });
  const d = result.document;
  return (result.unchanged ? ok : created)(res, { _id: d._id, documentType: d.documentType, contentType: d.contentType, size: d.size, verificationStatus: d.verificationStatus, createdAt: d.createdAt }, result.unchanged ? 'This file is already uploaded.' : 'Document uploaded. It will be verified by the admin team.');
});

// GET /api/onboarding/documents/:id/file — the owner or a verification admin; never public.
const documentFile = asyncHandler(async (req, res) => {
  const { document, data } = await service.readDocument(req.params.id, req.user);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `inline; filename="${document.documentType}${document.contentType === 'application/pdf' ? '.pdf' : document.contentType === 'image/png' ? '.png' : '.jpg'}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(document.contentType).send(data);
});

// POST /api/onboarding/submit — { role } sends the documents to the admin team.
const submit = asyncHandler(async (req, res) => {
  const request = await service.submitForVerification(req.user, String(req.body?.role || ''));
  return ok(res, request, 'Your account has been submitted for verification. Please wait for admin approval.');
});

// PUT /api/onboarding/profile — { role, fields, complete } saves progress; complete=true finalises.
const saveProfile = asyncHandler(async (req, res) => {
  const result = await service.saveProfile(req.user, String(req.body?.role || ''), req.body?.fields || {}, { complete: Boolean(req.body?.complete) });
  const message = result.reverification ? 'Saved. Because you changed verified identity details, the admin team will re-verify your account.'
    : result.profile.completed ? 'Your profile is complete. You can now access your dashboard.' : `Progress saved (${result.evaluation.percent}%).`;
  return ok(res, { completed: result.profile.completed, percent: result.evaluation.percent, missing: result.evaluation.missing, reverification: result.reverification }, message);
});

// GET /api/onboarding/history — the caller's own verification history.
const myHistory = asyncHandler(async (req, res) => {
  const rows = await VerificationHistory.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100).select('role previousStatus newStatus remarks createdAt');
  return ok(res, rows);
});

module.exports = { requirements, status, addAccountType, setSubtype, uploadDocument, documentFile, submit, saveProfile, myHistory };
