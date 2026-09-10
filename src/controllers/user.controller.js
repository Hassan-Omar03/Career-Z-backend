const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// PATCH /api/users/me
const updateMe = asyncHandler(async (req, res) => {
  const allowed = ['fullName', 'phone', 'country', 'language', 'currency', 'profilePhoto', 'companyName', 'donorType'];
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

module.exports = { updateMe, changePassword, listUsers, getUser, setUserStatus };
