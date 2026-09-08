const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const tokenService = require('../services/token.service');
const otpService = require('../services/otp.service');
const LoginAttempt = require('../models/LoginAttempt');
const BlockedIp = require('../models/BlockedIp');

// POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { fullName, email, password, phone, country, language } = req.body;

  if (!fullName || !email || !password) {
    throw new AppError('Full name, email and password are required.', 422);
  }
  if (password.length < 8) {
    throw new AppError('Password must be at least 8 characters.', 422);
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new AppError('An account with this email already exists.', 409);

  const passwordHash = await User.hashPassword(password);
  const user = await User.create({
    fullName,
    email: email.toLowerCase(),
    phone,
    passwordHash,
    country: country || null,
    language: language || 'en'
  });

  await otpService.issueOtp(user, 'email_verify');

  const tokens = await tokenService.issueTokenPair(user, {
    deviceInfo: req.headers['user-agent'],
    ip: req.ip
  });

  return created(res, {
    user: user.toSafeJSON(),
    permissions: user.permissions(),
    ...tokens
  }, 'Account created. Check your email for the verification code.');
});

// POST /api/auth/verify-email
const verifyEmail = asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) throw new AppError('Verification code is required.', 422);

  const valid = await otpService.verifyOtp(req.user, 'email_verify', code);
  if (!valid) throw new AppError('Invalid or expired verification code.', 400);

  req.user.emailVerified = true;
  await req.user.save();

  return ok(res, { user: req.user.toSafeJSON() }, 'Email verified successfully.');
});

// POST /api/auth/resend-verification
const resendVerification = asyncHandler(async (req, res) => {
  if (req.user.emailVerified) throw new AppError('Email is already verified.', 400);
  await otpService.issueOtp(req.user, 'email_verify');
  return ok(res, null, 'Verification code sent.');
});

async function recordLoginAttempt({ email, ip, userAgent, success, reason }) {
  try {
    await LoginAttempt.create({ email: (email || '').toLowerCase(), ip: ip || '', userAgent: userAgent || '', success, reason: reason || '' });
  } catch {
    // Never let attempt-logging failures block authentication.
  }
}

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  if (!email || !password) throw new AppError('Email and password are required.', 422);

  const blocked = await BlockedIp.findOne({ ip });
  if (blocked) {
    await recordLoginAttempt({ email, ip, userAgent, success: false, reason: 'blocked_ip' });
    throw new AppError('This network address has been blocked. Contact support if you believe this is an error.', 403);
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    await recordLoginAttempt({ email, ip, userAgent, success: false, reason: 'no_such_user' });
    throw new AppError('Invalid email or password.', 401);
  }

  const match = await user.comparePassword(password);
  if (!match) {
    await recordLoginAttempt({ email, ip, userAgent, success: false, reason: 'wrong_password' });
    throw new AppError('Invalid email or password.', 401);
  }

  if (user.status !== 'active') {
    await recordLoginAttempt({ email, ip, userAgent, success: false, reason: 'account_inactive' });
    throw new AppError('This account is not active.', 403);
  }

  user.lastLoginAt = new Date();
  await user.save();
  await recordLoginAttempt({ email, ip, userAgent, success: true });

  const tokens = await tokenService.issueTokenPair(user, {
    deviceInfo: req.headers['user-agent'],
    ip: req.ip
  });

  return ok(res, {
    user: user.toSafeJSON(),
    permissions: user.permissions(),
    ...tokens
  }, 'Login successful.');
});

// POST /api/auth/refresh
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError('Refresh token is required.', 422);

  const RefreshTokenModel = require('../models/RefreshToken');
  const tokenHash = tokenService.hashToken(refreshToken);
  const record = await RefreshTokenModel.findOne({ tokenHash });

  if (!record || record.revoked || record.expiresAt < new Date()) {
    throw new AppError('Refresh token is invalid or expired. Please log in again.', 401);
  }

  let payload;
  try {
    payload = tokenService.verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new AppError('Refresh token is invalid.', 401);
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new AppError('User no longer exists.', 401);

  const tokens = await tokenService.rotateRefreshToken(refreshToken, user, {
    deviceInfo: req.headers['user-agent'],
    ip: req.ip
  });

  return ok(res, tokens, 'Token refreshed.');
});

// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await tokenService.revokeRefreshToken(refreshToken);
  return ok(res, null, 'Logged out.');
});

// POST /api/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new AppError('Email is required.', 422);

  const user = await User.findOne({ email: email.toLowerCase() });
  // Always respond success to avoid leaking which emails are registered.
  if (user) await otpService.issueOtp(user, 'password_reset');

  return ok(res, null, 'If that email is registered, a reset code has been sent.');
});

// POST /api/auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    throw new AppError('Email, code and new password are required.', 422);
  }
  if (newPassword.length < 8) throw new AppError('Password must be at least 8 characters.', 422);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new AppError('Invalid request.', 400);

  const valid = await otpService.verifyOtp(user, 'password_reset', code);
  if (!valid) throw new AppError('Invalid or expired reset code.', 400);

  user.passwordHash = await User.hashPassword(newPassword);
  await user.save();

  return ok(res, null, 'Password reset successfully. Please log in.');
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => {
  return ok(res, { user: req.user.toSafeJSON(), permissions: req.permissions });
});

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  me
};
