const AppError = require('../utils/AppError');
const { hasPermission } = require('../config/rbac');

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

module.exports = { requirePermission, requireRole };
