const LoginAttempt = require('../models/LoginAttempt');
const BlockedIp = require('../models/BlockedIp');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// GET /api/security/login-attempts
const listLoginAttempts = asyncHandler(async (req, res) => {
  const { success, email } = req.query;
  const filter = {};
  if (success !== undefined) filter.success = success === 'true';
  if (email) filter.email = new RegExp(email, 'i');

  const attempts = await LoginAttempt.find(filter).sort({ createdAt: -1 }).limit(200);
  return ok(res, attempts);
});

// GET /api/security/blocked-ips
const listBlockedIps = asyncHandler(async (req, res) => {
  const blocked = await BlockedIp.find().populate('blockedBy', 'fullName email').sort({ createdAt: -1 });
  return ok(res, blocked);
});

// POST /api/security/blocked-ips
const blockIp = asyncHandler(async (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) throw new AppError('ip is required.', 422);

  const existing = await BlockedIp.findOne({ ip });
  if (existing) throw new AppError('This IP is already blocked.', 409);

  const blocked = await BlockedIp.create({ ip, reason: reason || '', blockedBy: req.user._id });
  return created(res, blocked, 'IP address blocked.');
});

// DELETE /api/security/blocked-ips/:id
const unblockIp = asyncHandler(async (req, res) => {
  const blocked = await BlockedIp.findById(req.params.id);
  if (!blocked) throw new AppError('Blocked IP record not found.', 404);
  await blocked.deleteOne();
  return ok(res, null, 'IP address unblocked.');
});

module.exports = { listLoginAttempts, listBlockedIps, blockIp, unblockIp };
