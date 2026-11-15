const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const tokenService = require('../services/token.service');
const otpService = require('../services/otp.service');
const LoginAttempt = require('../models/LoginAttempt');
const BlockedIp = require('../models/BlockedIp');
const { assertStrongPassword } = require('../utils/passwordPolicy');
const RoleRequest = require('../models/RoleRequest');
const VerificationHistory = require('../models/VerificationHistory');
const verificationConfig = require('../config/accountVerification');

// POST /api/auth/register
// What a client sends is never trusted to be text: an object or array here used to crash the
// request with a 500 that showed the internal error, or reach a database query as an operator.
const textOf = (v) => (typeof v === 'string' ? v.trim() : '');
const secretOf = (v) => (typeof v === 'string' ? v : '');
const codeOf = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailOf = (v) => {
  const email = textOf(v).toLowerCase();
  if (email.length > 254) throw new AppError('Enter a valid email address.', 422);
  return email;
};

const register = asyncHandler(async (req, res) => {
  const { language, acceptedTerms } = req.body;
  const fullName = textOf(req.body.fullName), email = emailOf(req.body.email), password = secretOf(req.body.password);
  const phone = textOf(req.body.phone), country = textOf(req.body.country), city = textOf(req.body.city);

  if (!fullName || !email || !password) {
    throw new AppError('Full name, email and password are required.', 422);
  }
  if (fullName.length > 100) throw new AppError('Keep your full name under 100 characters.', 422);
  if (!EMAIL.test(email)) throw new AppError('Enter a valid email address.', 422);
  if (phone.length > 30) throw new AppError('Enter a valid phone number.', 422);
  assertStrongPassword(password);
  if (!country || !city) {
    throw new AppError('Select your country and city.', 422);
  }
  if (acceptedTerms !== true) {
    throw new AppError('Please accept the Terms & Conditions and the Privacy Policy to continue.', 422);
  }

  const existing = await User.findOne({ email });
  if (existing) throw new AppError('An account with this email already exists.', 409);

  // Every new account picks exactly one account type; it stays locked until its documents are
  // approved by an admin and its mandatory profile is complete (see accountGate.service).
  const accountType = req.body.accountType || 'student';
  const role = verificationConfig.roleFor(accountType);
  if (!role) throw new AppError('Choose a valid account type.', 422);
  const subtype = String(req.body.subtype || verificationConfig.SUBTYPES[role]?.[0] || '');
  if (verificationConfig.SUBTYPES[role] && !verificationConfig.SUBTYPES[role].includes(subtype)) throw new AppError('Choose a valid account kind.', 422);

  const guardian=role==='student'?require('../services/studentGuardianContact.service').normalize(req.body,{email},{required:true}):null;
  const passwordHash = await User.hashPassword(password);
  const user = await User.create({
    fullName,
    email: email.toLowerCase(),
    phone,
    passwordHash,
    roles: [role],
    country: String(country).trim().slice(0, 100),
    city: String(city).trim().slice(0, 100),
    termsAcceptedAt: new Date(),
    language: language || 'en'
  });
  if(guardian)await require('../services/studentGuardianContact.service').sync(user,guardian);
  const request = await RoleRequest.create({ user: user._id, requestedRole: role, subtype, status: 'awaiting_documents' });
  require('../services/plugins.service').emit('user.registered', { userId: user._id, fullName: user.fullName, role, subtype: subtype || '', country: user.country, city: user.city });
  await VerificationHistory.create({ user: user._id, role, request: request._id, previousStatus: '', newStatus: 'awaiting_documents', remarks: 'Account registered.' });

  // The account is already created; a mail problem must not turn that into an error. The person can
  // ask for the code again from the onboarding page.
  const verificationSent = await otpService.issueOtp(user, 'email_verify').then(() => true).catch(() => false);

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
  const code = codeOf(req.body.code);
  if (!code) throw new AppError('Verification code is required.', 422);

  const valid = await otpService.verifyOtp(req.user, 'email_verify', code);
  if (!valid) throw new AppError('Invalid or expired verification code.', 400);

  req.user.emailVerified = true;
  await req.user.save();
  // Applications made as a guest with this email move into the account.
  await require('../services/guestClaim.service').claimFor(req.user).catch(() => {});

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
  const email = emailOf(req.body.email), password = secretOf(req.body.password);
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

  // Real 2FA enforcement — if the user turned this on in Settings, password alone is not
  // enough: an OTP is emailed and login only completes via POST /auth/login/verify-2fa.
  if (user.twoFactorEnabled) {
    await otpService.issueOtp(user, 'login_2fa');
    await recordLoginAttempt({ email, ip, userAgent, success: true, reason: '2fa_challenge_sent' });
    return ok(res, { twoFactorRequired: true, email: user.email }, 'Enter the login code sent to your email.');
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

// POST /api/auth/login/verify-2fa — completes login for accounts with 2FA enabled.
const verifyLogin2FA = asyncHandler(async (req, res) => {
  const email = emailOf(req.body.email), code = codeOf(req.body.code);
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];
  if (!email || !code) throw new AppError('Email and code are required.', 422);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new AppError('Invalid request.', 400);

  const valid = await otpService.verifyOtp(user, 'login_2fa', code);
  if (!valid) {
    await recordLoginAttempt({ email, ip, userAgent, success: false, reason: '2fa_invalid_code' });
    throw new AppError('Invalid or expired login code.', 400);
  }

  user.lastLoginAt = new Date();
  await user.save();
  await recordLoginAttempt({ email, ip, userAgent, success: true, reason: '2fa_verified' });

  const tokens = await tokenService.issueTokenPair(user, { deviceInfo: userAgent, ip });

  return ok(res, {
    user: user.toSafeJSON(),
    permissions: user.permissions(),
    ...tokens
  }, 'Login successful.');
});

// POST /api/auth/refresh
const refresh = asyncHandler(async (req, res) => {
  const refreshToken = textOf(req.body.refreshToken);
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
  if (!user || user.status !== 'active') throw new AppError('Account is not active. Please log in again.', 401);

  const tokens = await tokenService.rotateRefreshToken(refreshToken, user, {
    deviceInfo: req.headers['user-agent'],
    ip: req.ip
  });

  return ok(res, tokens, 'Token refreshed.');
});

// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  const refreshToken = textOf(req.body.refreshToken);
  if (refreshToken) await tokenService.revokeRefreshToken(refreshToken);
  return ok(res, null, 'Logged out.');
});

// POST /api/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const email = emailOf(req.body.email);
  if (!email) throw new AppError('Email is required.', 422);

  const user = await User.findOne({ email: email.toLowerCase() });
  // Always respond success to avoid leaking which emails are registered.
  if (user) await otpService.issueOtp(user, 'password_reset');

  return ok(res, null, 'If that email is registered, a reset code has been sent.');
});

// POST /api/auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const email = emailOf(req.body.email), code = codeOf(req.body.code), newPassword = secretOf(req.body.newPassword);
  if (!email || !code || !newPassword) {
    throw new AppError('Email, code and new password are required.', 422);
  }
  assertStrongPassword(newPassword, 'New password');

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new AppError('Invalid request.', 400);

  const valid = await otpService.verifyOtp(user, 'password_reset', code);
  if (!valid) throw new AppError('Invalid or expired reset code.', 400);

  user.passwordHash = await User.hashPassword(newPassword);
  await user.save();
  await tokenService.revokeAllForUser(user._id);

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
  verifyLogin2FA,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  me
};
