const RoleRequest = require('../models/RoleRequest');
const UserProfile = require('../models/UserProfile');
const VerificationHistory = require('../models/VerificationHistory');
const { VERIFIED_ROLES } = require('../config/accountVerification');

// Accounts created before mandatory verification existed keep their roles ("legacy approved") but
// still have to complete the mandatory profile. Everything created after this moment goes through
// documents → admin approval → profile completion.
const VERIFICATION_REQUIRED_FROM = new Date(process.env.VERIFICATION_REQUIRED_FROM || '2026-10-10T00:00:00Z');
const EXEMPT_ROLES = ['super_admin', 'admin', 'platform_staff'];
const normalize = (status) => (status === 'pending' ? 'pending_approval' : status);

// Gives a pre-existing account an approved (legacy) request for each role it already holds that
// has no request yet. Pending/rejected requests are left exactly as they are.
async function ensureLegacyVerification(user) {
  if (!user?.createdAt || user.createdAt >= VERIFICATION_REQUIRED_FROM) return;
  const roles = (user.roles || []).filter((r) => VERIFIED_ROLES.includes(r));
  if (!roles.length) return;
  const existing = new Set((await RoleRequest.find({ user: user._id, requestedRole: { $in: roles } }).select('requestedRole')).map((r) => r.requestedRole));
  for (const role of roles.filter((r) => !existing.has(r))) {
    const request = await RoleRequest.create({ user: user._id, requestedRole: role, status: 'approved', legacy: true, approvedAt: new Date(), reviewedAt: new Date(), reviewNotes: 'Existing account — approved automatically when mandatory verification was introduced.' });
    await VerificationHistory.create({ user: user._id, role, request: request._id, previousStatus: '', newStatus: 'approved', remarks: 'Legacy account approved automatically.' });
  }
}

// Per role: verification status + profile completion. accessibleRoles = approved AND complete.
async function gateFor(user) {
  const roles = user.roles || [];
  if (roles.some((r) => EXEMPT_ROLES.includes(r))) return { state: 'ok', exempt: true, accessibleRoles: roles, roles: [] };
  await ensureLegacyVerification(user);
  const verifiedRoles = roles.filter((r) => VERIFIED_ROLES.includes(r));
  const [requests, profiles] = await Promise.all([
    RoleRequest.find({ user: user._id, requestedRole: { $in: verifiedRoles } }).sort({ createdAt: -1 }).lean(),
    UserProfile.find({ user: user._id, role: { $in: verifiedRoles } }).select('role completed percent').lean()
  ]);
  const latest = new Map();
  requests.forEach((r) => { if (!latest.has(r.requestedRole)) latest.set(r.requestedRole, r); });
  const profileByRole = new Map(profiles.map((p) => [p.role, p]));
  const perRole = verifiedRoles.map((role) => {
    const request = latest.get(role);
    const status = request ? normalize(request.status) : 'awaiting_documents';
    const profile = profileByRole.get(role);
    return { role, status, requestId: request?._id || null, reason: request?.reviewNotes || '', resubmissionDocuments: request?.resubmissionDocuments || [], subtype: request?.subtype || '',
      profileCompleted: Boolean(profile?.completed), profilePercent: profile?.percent || 0 };
  });
  // Roles outside the verification programme (employer, institution_staff...) keep working as before.
  const accessibleRoles = [...roles.filter((r) => !VERIFIED_ROLES.includes(r)), ...perRole.filter((r) => r.status === 'approved' && r.profileCompleted).map((r) => r.role)];
  if (!verifiedRoles.length || perRole.some((r) => r.status === 'approved' && r.profileCompleted)) return { state: 'ok', accessibleRoles, roles: perRole };
  // Nothing usable yet: report the most actionable state.
  const order = ['suspended', 'profile_incomplete', 'rejected', 'resubmission_required', 'awaiting_documents', 'under_review', 'pending_approval'];
  const states = perRole.map((r) => (r.status === 'approved' ? 'profile_incomplete' : r.status));
  const state = order.find((s) => states.includes(s)) || 'pending_approval';
  const focus = perRole[states.indexOf(state)];
  return { state, role: focus?.role, reason: focus?.reason || '', accessibleRoles, roles: perRole };
}

// API paths an account may use before it is approved and its profile is complete.
const OPEN_PATHS = [
  /^\/api\/auth\//, /^\/api\/onboarding(\/|$)/, /^\/api\/users\/me\/?$/, /^\/api\/notifications\/(mine|push)/, /^\/api\/notifications\/[a-f0-9]{24}\/read$/,
  /^\/api\/roles\/my-requests/, /^\/api\/config\//, /^\/api\/translate/, /^\/api\/health/
];
const isOpenPath = (url) => OPEN_PATHS.some((re) => re.test(String(url || '').split('?')[0]));

const GATE_MESSAGES = {
  awaiting_documents: 'Upload your verification documents to continue.',
  pending_approval: 'Your account has been submitted for verification. Please wait for admin approval.',
  under_review: 'Your documents are currently being reviewed by our administration team.',
  rejected: 'Your account verification was rejected.',
  resubmission_required: 'Please re-upload the documents the admin asked for.',
  suspended: 'Your account has been suspended.',
  profile_incomplete: 'Complete your profile to access your dashboard.'
};

module.exports = { gateFor, ensureLegacyVerification, isOpenPath, GATE_MESSAGES, EXEMPT_ROLES, VERIFICATION_REQUIRED_FROM, normalize };
