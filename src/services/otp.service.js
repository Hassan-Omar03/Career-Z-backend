const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const VerificationCode = require('../models/VerificationCode');
const { sendEmail, otpEmailTemplate } = require('./email.service');

const OTP_TTL_MINUTES = 15;

function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

async function issueOtp(user, purpose) {
  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  // Invalidate previous unconsumed codes for the same purpose.
  await VerificationCode.updateMany({ user: user._id, purpose, consumed: false }, { consumed: true });

  await VerificationCode.create({ user: user._id, purpose, codeHash, expiresAt });

  const subject = purpose === 'email_verify' ? 'Verify your CareerZ.pk email' : 'Your CareerZ.pk password reset code';
  const heading = purpose === 'email_verify' ? 'Verify your email address' : 'Reset your password';
  const intro = purpose === 'email_verify'
    ? `Hi ${user.fullName || 'there'}, use the code below to verify your CareerZ.pk account.`
    : `Hi ${user.fullName || 'there'}, use the code below to reset your CareerZ.pk password.`;

  await sendEmail({
    to: user.email,
    subject,
    text: `Your CareerZ.pk verification code is: ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    html: otpEmailTemplate({ heading, intro, code, minutes: OTP_TTL_MINUTES })
  });

  return { expiresAt };
}

async function verifyOtp(user, purpose, code) {
  const record = await VerificationCode.findOne({
    user: user._id,
    purpose,
    consumed: false
  }).sort({ createdAt: -1 });

  if (!record) return false;
  if (record.expiresAt < new Date()) return false;

  const match = await bcrypt.compare(code, record.codeHash);
  if (!match) return false;

  record.consumed = true;
  await record.save();
  return true;
}

module.exports = { issueOtp, verifyOtp };
