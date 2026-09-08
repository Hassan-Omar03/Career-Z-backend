const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');
const RefreshToken = require('../models/RefreshToken');

function signAccessToken(user) {
  return jwt.sign({ sub: user._id.toString(), roles: user.roles }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user._id.toString() }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpires
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueTokenPair(user, meta = {}) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  const decoded = jwt.decode(refreshToken);
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    deviceInfo: meta.deviceInfo || '',
    ip: meta.ip || '',
    expiresAt: new Date(decoded.exp * 1000)
  });

  return { accessToken, refreshToken };
}

async function rotateRefreshToken(oldToken, user, meta = {}) {
  await RefreshToken.updateOne({ tokenHash: hashToken(oldToken) }, { revoked: true });
  return issueTokenPair(user, meta);
}

async function revokeRefreshToken(token) {
  await RefreshToken.updateOne({ tokenHash: hashToken(token) }, { revoked: true });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  verifyRefreshToken,
  hashToken
};
