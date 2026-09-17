const jwt = require('jsonwebtoken');
const env = require('../config/env');
const FeatureFlag = require('../models/FeatureFlag');

// A handful of paths must keep working during maintenance: health checks, login (so Super
// Admin can get in), token refresh (so an already-open Super Admin session doesn't get kicked
// out mid-maintenance), and /config/public (so the frontend can render the maintenance banner
// instead of a blank broken page).
const ALWAYS_ALLOWED = ['/health', '/auth/login', '/auth/refresh', '/config/public'];

// Enforces the 'maintenance_mode' global FeatureFlag (spec Part 16A.16 / 16D "Emergency
// Lockdown"). When it's on, every request is blocked with 503 except the always-allowed paths
// above and requests carrying a valid Super Admin access token — checked here by decoding the
// JWT directly (its payload already carries `roles`), so this doesn't need the full `protect`
// pipeline or an extra DB round trip on every request.
async function maintenanceGate(req, res, next) {
  let flag;
  try {
    flag = await FeatureFlag.findOne({ key: 'maintenance_mode', scope: 'global' });
  } catch {
    return next(); // DB hiccup here should never itself take the whole platform down
  }
  if (!flag || !flag.enabled) return next();

  if (ALWAYS_ALLOWED.some((p) => req.path === p)) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, env.jwt.accessSecret);
      if (Array.isArray(payload.roles) && payload.roles.includes('super_admin')) return next();
    } catch {
      // fall through to the maintenance response below
    }
  }

  return res.status(503).json({
    success: false,
    message: flag.label || 'CareerZ is currently undergoing scheduled maintenance. Please check back shortly.',
    errors: null
  });
}

module.exports = { maintenanceGate };
