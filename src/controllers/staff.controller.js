const StaffProfile = require('../models/StaffProfile');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// GET /api/admin/staff
const listStaff = asyncHandler(async (req, res) => {
  const staff = await StaffProfile.find().populate('user', 'fullName email status').populate('addedBy', 'fullName').sort({ createdAt: -1 });
  return ok(res, staff);
});

// POST /api/admin/staff — adds the platform_staff role (if missing) and assigns departments.
const addStaff = asyncHandler(async (req, res) => {
  const { email, departments, title } = req.body;
  if (!email || !Array.isArray(departments) || departments.length === 0) {
    throw new AppError('email and at least one department are required.', 422);
  }
  const invalid = departments.filter((d) => !StaffProfile.DEPARTMENTS.includes(d));
  if (invalid.length > 0) throw new AppError(`Invalid department(s): ${invalid.join(', ')}.`, 422);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new AppError('No user found with that email.', 404);
  if (user.roles.includes('super_admin')) throw new AppError('Super Admin already has full access.', 400);

  const existing = await StaffProfile.findOne({ user: user._id });
  if (existing) throw new AppError('This user is already on the staff team — update their departments instead.', 409);

  if (!user.roles.includes('platform_staff')) {
    user.roles.push('platform_staff');
    await user.save();
  }

  const profile = await StaffProfile.create({ user: user._id, departments, title: title || '', addedBy: req.user._id });
  const populated = await profile.populate('user', 'fullName email status');
  return created(res, populated, 'Staff member added.');
});

// PATCH /api/admin/staff/:id — change departments/title/active.
const updateStaff = asyncHandler(async (req, res) => {
  const profile = await StaffProfile.findById(req.params.id);
  if (!profile) throw new AppError('Staff record not found.', 404);

  const { departments, title, active } = req.body;
  if (departments !== undefined) {
    const invalid = departments.filter((d) => !StaffProfile.DEPARTMENTS.includes(d));
    if (invalid.length > 0) throw new AppError(`Invalid department(s): ${invalid.join(', ')}.`, 422);
    profile.departments = departments;
  }
  if (title !== undefined) profile.title = title;
  if (active !== undefined) profile.active = active;
  await profile.save();

  const populated = await profile.populate('user', 'fullName email status');
  return ok(res, populated, 'Staff member updated.');
});

// DELETE /api/admin/staff/:id — removes the platform_staff role entirely and the profile.
const removeStaff = asyncHandler(async (req, res) => {
  const profile = await StaffProfile.findById(req.params.id);
  if (!profile) throw new AppError('Staff record not found.', 404);

  const user = await User.findById(profile.user);
  if (user) {
    user.roles = user.roles.filter((r) => r !== 'platform_staff');
    await user.save();
  }
  await profile.deleteOne();
  return ok(res, null, 'Staff member removed.');
});

module.exports = { listStaff, addStaff, updateStaff, removeStaff };
