const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// Staff permissions the owner can grant from Staff Management. AI permissions keep their own
// dedicated endpoint (ai-permissions), so they are preserved untouched here.
const GRANTABLE = {
  'communication:send': 'Send broadcasts / notifications',
  'fee:manage': 'Manage fees',
  'application:approve': 'Approve admissions',
  'grading:manage': 'Manage grading scale',
  'questionbank:manage': 'Manage question bank',
  'forum:moderate': 'Moderate discussion forums',
  'settings:manage': 'Manage institute settings'
};

// GET /api/institutions/staff-permissions — the catalogue shown in the UI.
const listGrantable = asyncHandler(async (req, res) => ok(res, Object.entries(GRANTABLE).map(([key, label]) => ({ key, label }))));

// PATCH /api/institutions/:id/staff/:userId/permissions — owner-only; body { permissions: [] }.
const updateStaffPermissions = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (institution.owner.toString() !== req.user._id.toString()) throw new AppError('Only the owner can change staff permissions.', 403);
  const entry = institution.staff.find((s) => s.user.toString() === req.params.userId);
  if (!entry) throw new AppError('This user is not institution staff.', 404);
  const requested = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : [];
  const unknown = requested.filter((p) => !GRANTABLE[p]);
  if (unknown.length) throw new AppError(`Unknown permission(s): ${unknown.join(', ')}`, 422);
  const kept = (entry.permissions || []).filter((p) => !GRANTABLE[p]); // e.g. ai:use / ai:manage
  entry.permissions = Array.from(new Set([...kept, ...requested]));
  await institution.save();
  return ok(res, { user: entry.user, permissions: entry.permissions }, 'Staff permissions updated.');
});

// Owner, or staff holding `permission`. Shared by the features that use these permissions.
function assertOwnerOrPermission(institution, userId, permission) {
  if (institution.owner.toString() === userId.toString()) return;
  const entry = institution.staff.find((s) => s.user.toString() === userId.toString());
  if (!entry?.permissions?.includes(permission)) throw new AppError(`This needs the "${GRANTABLE[permission] || permission}" permission from the institution owner.`, 403);
}

module.exports = { GRANTABLE, listGrantable, updateStaffPermissions, assertOwnerOrPermission };
