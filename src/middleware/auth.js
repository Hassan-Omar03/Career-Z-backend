const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// Verifies the access token and attaches req.user (Mongoose doc) + req.permissions.
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw new AppError('Authentication required.', 401);
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    throw new AppError('Invalid or expired token.', 401);
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new AppError('User no longer exists.', 401);
  if (user.status !== 'active') throw new AppError('Account is not active.', 403);

  req.user = user;
  req.permissions = user.permissions();
  next();
});

// Optional auth: attaches user if a valid token is present, otherwise continues anonymously.
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = jwt.verify(token, env.jwt.accessSecret);
    const user = await User.findById(payload.sub);
    if (user && user.status === 'active') {
      req.user = user;
      req.permissions = user.permissions();
    }
  } catch (err) {
    // ignore invalid token for optional auth
  }
  next();
});

module.exports = { protect, optionalAuth };
