const crypto = require('crypto');
const User = require('../models/User');
const RoleRequest = require('../models/RoleRequest');
const UserProfile = require('../models/UserProfile');
const VerificationDocument = require('../models/VerificationDocument');
const VerificationDocumentFile = require('../models/VerificationDocumentFile');
const VerificationHistory = require('../models/VerificationHistory');
const AdminAuditLog = require('../models/AdminAuditLog');
const AppError = require('../utils/AppError');
const { encrypt, decrypt } = require('../utils/encryption');
const cfg = require('../config/accountVerification');
const { normalize } = require('./accountGate.service');

const MAX_IMAGE_BYTES = Number(process.env.VERIFICATION_MAX_IMAGE_MB || 5) * 1024 * 1024;
const MAX_PDF_BYTES = Number(process.env.VERIFICATION_MAX_PDF_MB || 10) * 1024 * 1024;

// ---------- helpers ----------
async function notifyUser(userId, title, body) {
  const { notify } = require('./notification.service');
  const user = await User.findById(userId).select('email');
  await notify(userId, { title, body }, { email: true, toAddress: user?.email }).catch(() => {});
}
async function notifyAdmins(title, body) {
  await require('./notification.service').notifyAdmins({ title, body }).catch(() => {});
}
async function recordHistory({ user, role, request, admin = null, previousStatus, newStatus, remarks = '' }) {
  await VerificationHistory.create({ user, role, request, admin, previousStatus: previousStatus || '', newStatus, remarks });
}

// File type from its first bytes — the declared Content-Type/extension is never trusted.
function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

async function latestRequest(userId, role) {
  return RoleRequest.findOne({ user: userId, requestedRole: role }).sort({ createdAt: -1 });
}

// ---------- requirements / status ----------
async function activeDocuments(userId, role) {
  return VerificationDocument.find({ user: userId, role, active: true }).select('-__v').sort({ createdAt: -1 }).lean();
}

function evaluateDocuments(role, subtype, docs) {
  const byType = new Map(docs.map((d) => [d.documentType, d]));
  const groups = cfg.documentRequirements(role, subtype).map((g) => {
    const satisfied = g.anyOf.some((set) => set.every((t) => byType.has(t)));
    return { label: g.label, mandatory: g.mandatory !== false, satisfied, options: g.anyOf.map((set) => set.map((t) => ({ type: t, label: cfg.DOCUMENT_TYPES[t], imageOnly: cfg.IMAGE_ONLY.has(t), uploaded: byType.get(t) || null }))) };
  });
  return { groups, complete: groups.every((g) => !g.mandatory || g.satisfied) };
}

const PATTERNS = {
  cnic: [/^\d{5}-?\d{7}-?\d$/, 'Enter 13 digits, e.g. 35202-1234567-1.'],
  phone: [/^\+?[0-9][0-9\s-]{8,16}$/, 'Enter a valid phone number.'],
  email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'],
  year: [/^(19[5-9]\d|20\d\d)$/, 'Enter a 4-digit year.'],
  url: [/^https?:\/\/\S+$/, 'Enter a full link starting with http(s)://']
};

function fieldValue(profile, field) {
  if (field.sensitive) return profile?.sensitive?.[field.key]?.encrypted ? '••••' : '';
  return profile?.fields?.[field.key] ?? '';
}

function evaluateProfile(role, subtype, profile) {
  const fields = cfg.profileFields(role, subtype);
  const required = fields.filter((f) => f.required);
  const filled = (f) => (f.sensitive ? Boolean(profile?.sensitive?.[f.key]?.encrypted) : String(profile?.fields?.[f.key] ?? '').trim() !== '');
  const missing = required.filter((f) => !filled(f)).map((f) => ({ key: f.key, label: f.label }));
  const percent = required.length ? Math.round(((required.length - missing.length) / required.length) * 100) : 100;
  return { fields, missing, percent, complete: missing.length === 0 };
}

async function statusFor(user, gate) {
  const roles = await Promise.all(gate.roles.map(async (r) => {
    const [docs, profile] = await Promise.all([activeDocuments(user._id, r.role), UserProfile.findOne({ user: user._id, role: r.role }).lean()]);
    const documentState = evaluateDocuments(r.role, r.subtype, docs);
    const profileState = evaluateProfile(r.role, r.subtype, profile);
    return {
      ...r, label: cfg.ROLE_LABEL[r.role] || r.role, subtypes: cfg.SUBTYPES[r.role] || [],
      documents: documentState,
      profile: {
        percent: profileState.percent, complete: profileState.complete, missing: profileState.missing,
        fields: profileState.fields.map((f) => ({ ...f, value: fieldValue(profile, f), last4: f.sensitive ? profile?.sensitive?.[f.key]?.last4 || '' : undefined }))
      }
    };
  }));
  return { state: gate.state, role: gate.role || null, reason: gate.reason || '', exempt: Boolean(gate.exempt), accessibleRoles: gate.accessibleRoles, roles };
}

// ---------- documents ----------
async function uploadDocument({ user, role, documentType, buffer, originalName }) {
  const request = await latestRequest(user._id, role);
  if (!request || !(user.roles || []).includes(role)) throw new AppError('Choose one of your own account types.', 403);
  const status = normalize(request.status);
  if (status === 'suspended') throw new AppError('This account type is suspended.', 403);
  if (!cfg.allowedDocumentTypes(role, request.subtype).has(documentType)) throw new AppError(`${cfg.DOCUMENT_TYPES[documentType] || documentType} is not a document this account type submits.`, 422);
  if (!buffer?.length) throw new AppError('The file is empty.', 422);
  const contentType = sniff(buffer);
  if (!contentType) throw new AppError('Upload a JPG, PNG or PDF file.', 422);
  if (cfg.IMAGE_ONLY.has(documentType) && contentType === 'application/pdf') throw new AppError(`${cfg.DOCUMENT_TYPES[documentType]} must be a JPG or PNG image.`, 422);
  const limit = contentType === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > limit) throw new AppError(`File too large — maximum ${Math.round(limit / 1048576)} MB.`, 413);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const current = await VerificationDocument.findOne({ user: user._id, role, documentType, active: true });
  if (current?.sha256 === sha256) return { document: current, unchanged: true };
  const reusedHere = await VerificationDocument.findOne({ user: user._id, role, sha256, active: true, documentType: { $ne: documentType } });
  if (reusedHere) throw new AppError(`This is the same file you uploaded as "${cfg.DOCUMENT_TYPES[reusedHere.documentType]}". Upload the correct document.`, 409);

  const file = await VerificationDocumentFile.create({ owner: user._id, data: buffer });
  const document = await VerificationDocument.create({ user: user._id, role, documentType, file: file._id, originalName: String(originalName || '').slice(0, 200), contentType, size: buffer.length, sha256 });
  if (current) await VerificationDocument.updateOne({ _id: current._id }, { $set: { active: false, replacedAt: new Date() } });

  // Replacing an identity document on an approved account needs the admin to look again.
  if (current && status === 'approved') {
    const previous = request.status;
    request.status = 'pending_approval'; request.submittedAt = new Date();
    await request.save();
    await recordHistory({ user: user._id, role, request: request._id, previousStatus: previous, newStatus: 'pending_approval', remarks: `Re-verification: ${cfg.DOCUMENT_TYPES[documentType]} was replaced.` });
    await notifyAdmins(`Re-verification needed: ${cfg.ROLE_LABEL[role]}`, `${user.fullName} (${user.email}) replaced their ${cfg.DOCUMENT_TYPES[documentType]}.`);
  }
  return { document, unchanged: false };
}

async function readDocument(documentId, viewer) {
  const document = await VerificationDocument.findById(documentId);
  if (!document) throw new AppError('Document not found.', 404);
  const isOwner = document.user.toString() === viewer._id.toString();
  const isReviewer = (viewer.roles || []).some((r) => ['super_admin', 'admin', 'platform_staff'].includes(r));
  if (!isOwner && !isReviewer) throw new AppError('Document not found.', 404);
  if (isReviewer && (viewer.roles || []).includes('platform_staff') && !viewer.roles.some((r) => ['admin', 'super_admin'].includes(r))) {
    const StaffProfile = require('../models/StaffProfile');
    const staff = await StaffProfile.findOne({ user: viewer._id, active: true });
    if (!staff?.departments?.includes('verification')) throw new AppError('Document not found.', 404);
  }
  const file = await VerificationDocumentFile.findById(document.file);
  if (!file) throw new AppError('Document file is missing.', 410);
  return { document, data: file.data };
}

async function submitForVerification(user, role) {
  const request = await latestRequest(user._id, role);
  if (!request || !(user.roles || []).includes(role)) throw new AppError('Choose one of your own account types.', 403);
  const status = normalize(request.status);
  if (!['awaiting_documents', 'rejected', 'resubmission_required'].includes(status)) throw new AppError(status === 'approved' ? 'This account type is already approved.' : 'Your documents are already with the admin team.', 409);
  const docs = await activeDocuments(user._id, role);
  const evaluation = evaluateDocuments(role, request.subtype, docs);
  if (!evaluation.complete) throw new AppError(`Upload all mandatory documents first: ${evaluation.groups.filter((g) => g.mandatory && !g.satisfied).map((g) => g.label).join('; ')}.`, 422);
  if (status === 'resubmission_required' && request.resubmissionDocuments?.length) {
    const replaced = new Set(docs.filter((d) => d.verificationStatus === 'pending').map((d) => d.documentType));
    const still = request.resubmissionDocuments.filter((t) => !replaced.has(t));
    if (still.length) throw new AppError(`Re-upload: ${still.map((t) => cfg.DOCUMENT_TYPES[t]).join(', ')}.`, 422);
  }
  const previous = request.status;
  request.status = 'pending_approval'; request.submittedAt = new Date();
  await request.save();
  await recordHistory({ user: user._id, role, request: request._id, previousStatus: previous, newStatus: 'pending_approval', remarks: status === 'awaiting_documents' ? 'Documents submitted.' : 'Documents resubmitted.' });
  await notifyAdmins('New account verification request received.', `${cfg.ROLE_LABEL[role]} account: ${user.fullName} (${user.email}).`);
  return request;
}

// ---------- profile ----------
async function saveProfile(user, role, input = {}, { complete = false } = {}) {
  const request = await latestRequest(user._id, role);
  if (!request || !(user.roles || []).includes(role)) throw new AppError('Choose one of your own account types.', 403);
  if (normalize(request.status) !== 'approved') throw new AppError('Your account must be approved before you complete the profile.', 403);
  let profile = await UserProfile.findOne({ user: user._id, role });
  if (!profile) profile = new UserProfile({ user: user._id, role, subtype: request.subtype });
  const fields = cfg.profileFields(role, request.subtype);
  const errors = {};
  const sensitiveChanged = [];
  for (const f of fields) {
    if (!(f.key in input)) continue;
    let value = typeof input[f.key] === 'string' ? input[f.key].trim() : input[f.key];
    if (value === null || value === undefined) value = '';
    value = String(value).slice(0, f.type === 'textarea' ? 2000 : 200);
    if (f.sensitive && value === '••••') continue; // masked placeholder — unchanged
    if (value) {
      if (f.pattern && PATTERNS[f.pattern] && !PATTERNS[f.pattern][0].test(value)) { errors[f.key] = PATTERNS[f.pattern][1]; continue; }
      if (f.type === 'select' && !f.options.includes(value)) { errors[f.key] = 'Choose one of the options.'; continue; }
      if (f.type === 'date') {
        const d = new Date(value);
        if (Number.isNaN(d.getTime()) || d > new Date() || d.getFullYear() < 1900) { errors[f.key] = 'Enter a valid date in the past.'; continue; }
      }
    }
    if (f.sensitive) {
      const digits = value.replace(/\D/g, '');
      const before = profile.sensitive?.[f.key]?.encrypted ? decrypt(profile.sensitive[f.key].encrypted) : '';
      if (before && digits !== before) sensitiveChanged.push(f.label);
      profile.sensitive = { ...(profile.sensitive || {}), [f.key]: digits ? { encrypted: encrypt(digits), last4: digits.slice(-4) } : undefined };
      profile.markModified('sensitive');
    } else {
      const before = profile.fields?.[f.key];
      if (['fatherName', 'dateOfBirth'].includes(f.key) && before && before !== value && profile.completed) sensitiveChanged.push(f.label);
      profile.fields = { ...(profile.fields || {}), [f.key]: value };
      profile.markModified('fields');
    }
  }
  if (Object.keys(errors).length) throw new AppError('Please fix the highlighted fields.', 422, { fields: errors });
  const evaluation = evaluateProfile(role, request.subtype, profile);
  profile.percent = evaluation.percent;
  const wasComplete = profile.completed;
  if (complete && !evaluation.complete) {
    await profile.save();
    throw new AppError('Some required fields are still missing.', 422, { missing: evaluation.missing });
  }
  // Completion is recalculated on every save: removing a required value makes it incomplete again.
  profile.completed = evaluation.complete && (complete || wasComplete);
  if (profile.completed && !wasComplete) profile.completedAt = new Date();
  await profile.save();
  if (profile.completed && !wasComplete) await notifyUser(user._id, 'Your profile is complete.', 'Your profile is complete. You can now access your dashboard.');
  // Changing verified identity details after approval sends the account back to the admin.
  if (sensitiveChanged.length) {
    const previous = request.status;
    request.status = 'pending_approval'; request.submittedAt = new Date();
    await request.save();
    await recordHistory({ user: user._id, role, request: request._id, previousStatus: previous, newStatus: 'pending_approval', remarks: `Re-verification: changed ${sensitiveChanged.join(', ')}.` });
    await notifyAdmins(`Re-verification needed: ${cfg.ROLE_LABEL[role]}`, `${user.fullName} changed ${sensitiveChanged.join(', ')}.`);
  }
  return { profile, evaluation, reverification: sensitiveChanged.length > 0 };
}

// ---------- admin decisions ----------
const ACTIONS = {
  under_review: { from: ['pending_approval'], to: 'under_review' },
  approve: { from: ['pending_approval', 'under_review'], to: 'approved' },
  reject: { from: ['pending_approval', 'under_review', 'resubmission_required'], to: 'rejected', reason: true },
  request_resubmission: { from: ['pending_approval', 'under_review'], to: 'resubmission_required', reason: true },
  suspend: { from: ['approved'], to: 'suspended', reason: true },
  reinstate: { from: ['suspended'], to: 'approved' }
};

async function decide({ requestId, admin, action, reason = '', documents = [], meta = {} }) {
  const rule = ACTIONS[action];
  if (!rule) throw new AppError('Unknown verification action.', 422);
  const request = await RoleRequest.findById(requestId);
  if (!request) throw new AppError('Verification request not found.', 404);
  if (String(request.user) === String(admin._id)) throw new AppError('You cannot review your own account.', 403);
  const current = normalize(request.status);
  if (!rule.from.includes(current)) throw new AppError(`Cannot ${action.replace('_', ' ')} an account that is ${current.replace('_', ' ')}.`, 409);
  const cleanReason = String(reason || '').trim().slice(0, 1000);
  if (rule.reason && !cleanReason) throw new AppError('Give a reason for the user.', 422);
  const role = request.requestedRole;
  let resubmit = [];
  if (action === 'request_resubmission') {
    const allowed = cfg.allowedDocumentTypes(role, request.subtype);
    resubmit = [...new Set((documents || []).map(String))].filter((t) => allowed.has(t));
    if (!resubmit.length) throw new AppError('Choose which documents must be re-uploaded.', 422);
  }

  const previous = request.status;
  Object.assign(request, { status: rule.to, reviewedBy: admin._id, reviewedAt: new Date(), reviewNotes: cleanReason, resubmissionDocuments: resubmit });
  if (rule.to === 'approved') { request.approvedAt = new Date(); request.approvedBy = admin._id; }
  await request.save();

  const user = await User.findById(request.user);
  if (rule.to === 'approved' && user && !user.roles.includes(role)) { user.roles = [...user.roles, role]; await user.save(); }
  const now = new Date();
  if (action === 'approve') await VerificationDocument.updateMany({ user: request.user, role, active: true }, { $set: { verificationStatus: 'approved', verifiedBy: admin._id, verifiedAt: now, rejectionReason: '' } });
  if (action === 'reject') await VerificationDocument.updateMany({ user: request.user, role, active: true }, { $set: { verificationStatus: 'rejected', verifiedBy: admin._id, verifiedAt: now, rejectionReason: cleanReason } });
  if (action === 'request_resubmission') await VerificationDocument.updateMany({ user: request.user, role, active: true, documentType: { $in: resubmit } }, { $set: { verificationStatus: 'rejected', verifiedBy: admin._id, verifiedAt: now, rejectionReason: cleanReason } });

  await recordHistory({ user: request.user, role, request: request._id, admin: admin._id, previousStatus: previous, newStatus: rule.to, remarks: cleanReason });
  await AdminAuditLog.create({ actor: admin._id, action: `verification.${action}`, method: meta.method || 'POST', path: meta.path || '/api/admin/verifications', targetType: 'RoleRequest', targetId: String(request._id), statusCode: 200, ip: meta.ip || '', metadata: { role, user: String(request.user), from: previous, to: rule.to } }).catch(() => {});

  const label = cfg.ROLE_LABEL[role] || role;
  const messages = {
    approved: ['Your account has been approved.', `Your ${label} account has been approved. Please complete your profile to access your dashboard.`],
    rejected: ['Your account verification was rejected.', `Your ${label} account verification was rejected. Please review the reason and resubmit the required documents.\n\nReason: ${cleanReason}`],
    resubmission_required: ['Please re-upload some documents.', `The admin team needs new copies of: ${resubmit.map((t) => cfg.DOCUMENT_TYPES[t]).join(', ')}.\n\nReason: ${cleanReason}`],
    suspended: ['Your account has been suspended.', `Your ${label} account was suspended.\n\nReason: ${cleanReason}`],
    under_review: ['Your documents are being reviewed.', `Your ${label} documents are currently being reviewed by our administration team.`]
  };
  const [title, body] = action === 'reinstate' ? ['Your account has been reinstated.', `Your ${label} account is active again.`] : messages[rule.to];
  await notifyUser(request.user, title, body);
  require('../realtime/socket').emitToUser?.(request.user, 'dashboard:update', { reason: 'verification', status: rule.to });
  return request;
}

module.exports = { uploadDocument, readDocument, submitForVerification, saveProfile, decide, statusFor, evaluateDocuments, evaluateProfile, activeDocuments, sniff, ACTIONS, MAX_IMAGE_BYTES, MAX_PDF_BYTES };
