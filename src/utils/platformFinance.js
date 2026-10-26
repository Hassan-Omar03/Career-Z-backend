// CareerZ's own finance reviewers: Super Admin / Admin, or platform staff in the finance
// department. Every payment is approved by them before it counts or is released, so the platform
// can always show who checked which proof.
async function isPlatformFinance(user) {
  const roles = user?.roles || [];
  if (roles.includes('super_admin') || roles.includes('admin')) return true;
  if (!roles.includes('platform_staff')) return false;
  const profile = await require('../models/StaffProfile').findOne({ user: user._id, active: true }).select('departments').lean();
  return Boolean(profile?.departments?.includes('finance'));
}
async function assertPlatformFinance(user) {
  if (!(await isPlatformFinance(user))) {
    const AppError = require('./AppError');
    throw new AppError('Only the CareerZ admin team verifies payments. It checks the proof and then releases it.', 403);
  }
}
module.exports = { isPlatformFinance, assertPlatformFinance };
