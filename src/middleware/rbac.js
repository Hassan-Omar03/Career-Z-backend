const AppError = require('../utils/AppError');
const { hasPermission } = require('../config/rbac');
const asyncHandler = require('../utils/asyncHandler');

// Requires the user to hold at least one of the given permission strings.
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) throw new AppError('Authentication required.', 401);
    const ok = permissions.some((p) => hasPermission(req.permissions, p));
    if (!ok) throw new AppError('You do not have permission to perform this action.', 403);
    next();
  };
}

// Requires the user to hold at least one of the given roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) throw new AppError('Authentication required.', 401);
    const ok = req.user.roles.includes('super_admin') || roles.some((r) => req.user.roles.includes(r));
    if (!ok) throw new AppError('This action requires a different role.', 403);
    next();
  };
}

// Requires access to a specific internal department (spec Part 16A.14 "Staff Management" —
// each employee only sees what Super Admin granted). super_admin and admin always pass
// unconditionally; platform_staff only passes if their StaffProfile includes this department.
// Anyone without admin/super_admin/platform_staff never reaches the DB check at all.
function requireDepartment(...departments) {
  return asyncHandler(async (req, res, next) => {
    if (!req.user) throw new AppError('Authentication required.', 401);
    if (req.user.roles.includes('super_admin') || req.user.roles.includes('admin')) return next();
    if (!req.user.roles.includes('platform_staff')) throw new AppError('This action requires a different role.', 403);

    const StaffProfile = require('../models/StaffProfile');
    const profile = await StaffProfile.findOne({ user: req.user._id, active: true });
    const ok = profile && departments.some((d) => profile.departments.includes(d));
    if (!ok) throw new AppError(`You do not have access to the ${departments.join('/')} department.`, 403);
    next();
  });
}

module.exports = { requirePermission, requireRole, requireDepartment };
