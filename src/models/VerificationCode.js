const mongoose = require('mongoose');

// Used for email verification OTP and password-reset OTP.
const verificationCodeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['email_verify', 'password_reset'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('VerificationCode', verificationCodeSchema);
