const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const tokenService = require('../services/token.service');

// PATCH /api/users/me
const updateMe = asyncHandler(async (req, res) => {
  const allowed = ['fullName', 'phone', 'country', 'language', 'currency', 'profilePhoto', 'coverImage', 'companyName', 'donorType', 'storeStatus', 'twoFactorEnabled'];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) req.user[f] = req.body[f];
  });
  await req.user.save();
  return ok(res, { user: req.user.toSafeJSON() });
});

// PATCH /api/users/me/password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw new AppError('currentPassword and newPassword are required.', 422);
  if (newPassword.length < 8) throw new AppError('Password must be at least 8 characters.', 422);

  const match = await req.user.comparePassword(currentPassword);
  if (!match) throw new AppError('Current password is incorrect.', 401);

  req.user.passwordHash = await User.hashPassword(newPassword);
  await req.user.save();
  return ok(res, null, 'Password updated.');
});

// DELETE /api/users/me — self-service account deletion. Requires the current password as
// confirmation (same bar as changing it) so a hijacked/left-open session can't delete an
// account outright. Soft-deletes: status flips to 'deleted' (protect() already rejects any
// non-'active' user on the next request) and the email is freed so the person can re-register
// later if they choose, rather than being permanently locked out of their own address.
const deleteMe = asyncHandler(async (req, res) => {
  const { currentPassword } = req.body;
  if (!currentPassword) throw new AppError('currentPassword is required to delete your account.', 422);

  const match = await req.user.comparePassword(currentPassword);
  if (!match) throw new AppError('Current password is incorrect.', 401);

  if (req.user.roles.includes('super_admin')) {
    throw new AppError('A Super Admin account cannot self-delete. Ask another Super Admin to transfer this role first.', 403);
  }

  req.user.status = 'deleted';
  req.user.deletedAt = new Date();
  req.user.email = `deleted_${req.user._id}_${req.user.email}`;
  await req.user.save();
  await tokenService.revokeAllForUser(req.user._id);

  return ok(res, null, 'Your account has been deleted.');
});

// GET /api/users/search?q= — any signed-in user, used to pick a complaint target
// ("who is this against?"). Deliberately not admin-only, but returns only a few
// safe fields (no status/verification/passwordHash) and a small capped result set.
const searchUsers = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return ok(res, []);

  const users = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ fullName: { $regex: q, $options: 'i' } }, { email: { $regex: q, $options: 'i' } }]
  })
    .select('fullName email phone roles')
    .limit(8);

  return ok(res, users);
});

// ---- Admin ----

// GET /api/users (admin)
const listUsers = asyncHandler(async (req, res) => {
  const { role, status, q, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (role) filter.roles = role;
  if (status) filter.status = status;
  if (q) filter.$or = [{ fullName: { $regex: q, $options: 'i' } }, { email: { $regex: q, $options: 'i' } }];

  const skip = (Number(page) - 1) * Number(limit);
  const [users, total] = await Promise.all([
    User.find(filter).select('-passwordHash').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    User.countDocuments(filter)
  ]);

  return ok(res, { users, total, page: Number(page), limit: Number(limit) });
});

// GET /api/users/:id (admin)
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('-passwordHash');
  if (!user) throw new AppError('User not found.', 404);
  return ok(res, user);
});

// PATCH /api/users/:id/status (admin) - suspend/activate/disable
const setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended', 'disabled'].includes(status)) {
    throw new AppError('status must be active, suspended or disabled.', 422);
  }

  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found.', 404);
  if (user.roles.includes('super_admin')) throw new AppError('Cannot change status of a Super Admin.', 403);

  user.status = status;
  await user.save();
  return ok(res, { user: user.toSafeJSON() }, `User ${status}.`);
});

module.exports = { updateMe, changePassword, deleteMe, searchUsers, listUsers, getUser, setUserStatus };
