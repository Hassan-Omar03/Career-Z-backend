const Setting = require('../models/Setting');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

let cached = null;
let cachedAt = 0;
async function controls() {
  if (cached && Date.now() - cachedAt < 5000) return cached;
  const row = await Setting.findOne({ key: 'admin_control_center' }).lean();
  cached = row?.value?.emergency || {};
  cachedAt = Date.now();
  return cached;
}

async function emergencyControls(req, res, next) {
  try {
    const state = await controls();
    let roles = req.user?.roles || [];
    const header = req.headers.authorization || '';
    if (!roles.length && header.startsWith('Bearer ')) {
      try { roles = jwt.verify(header.slice(7), env.jwt.accessSecret).roles || []; } catch { /* anonymous */ }
    }
    if (roles.includes('super_admin')) return next();
    const blocked =
      (state.disablePayments && /^\/(payments|wallet|subscriptions)/.test(req.path)) ||
      (state.disableRegistrations && req.path === '/auth/register') ||
      (state.disableAi && req.path.startsWith('/ai'));
    if (blocked) return res.status(503).json({ success: false, message: state.notice || 'This service is temporarily disabled by the platform administrator.', errors: null });
  } catch { /* fail open if settings cannot be read */ }
  next();
}
module.exports = { emergencyControls };
