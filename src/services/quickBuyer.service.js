const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const otp = require('./otp.service');
const tokens = require('./token.service');

// Quick checkout for people without a CareerZ account: name, email and phone, then the 6-digit
// code sent to that email. A light buyer account (no account type, nothing to verify) is made
// so the order, the bank-transfer payment and order tracking work exactly as for members.

const fail = (message, status = 422) => new AppError(message, status);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9\s-]{8,16}$/;

async function start({ name, email, phone } = {}) {
  const fullName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const mail = String(email || '').trim().toLowerCase();
  const tel = String(phone || '').trim();
  if (fullName.length < 3) throw fail('Write your full name.');
  if (!EMAIL.test(mail)) throw fail('Enter a valid email address.');
  if (!PHONE.test(tel)) throw fail('Enter a valid phone number, e.g. 03001234567.');
  let user = await User.findOne({ email: mail });
  if (user && !user.quickBuyer) throw fail('You already have a CareerZ account with this email. Please log in to order.', 409);
  if (user && user.emailVerified) throw fail('This email is already used for quick checkout. Use "Log in" and "Forgot password" to set a password, or enter another email.', 409);
  if (!user) {
    user = await User.create({ fullName, email: mail, phone: tel, roles: [], quickBuyer: true, emailVerified: false, status: 'active', passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10) });
  } else {
    user.fullName = fullName;
    user.phone = tel;
    await user.save();
  }
  await otp.issueOtp(user, 'email_verify');
  return { email: mail, sent: true };
}

async function verify({ email, code } = {}, meta = {}) {
  const mail = String(email || '').trim().toLowerCase();
  const user = await User.findOne({ email: mail, quickBuyer: true });
  if (!user) throw fail('Start quick checkout again.', 404);
  if (!/^\d{6}$/.test(String(code || '').trim()) || !(await otp.verifyOtp(user, 'email_verify', String(code).trim()))) throw fail('The code is wrong or expired. Check your email or ask for a new code.');
  user.emailVerified = true;
  await user.save();
  const pair = await tokens.issueTokenPair(user, meta);
  return { user: user.toSafeJSON(), permissions: user.permissions(), ...pair };
}

module.exports = { start, verify };
