const mongoose = require('mongoose');

const loginAttemptSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    success: { type: Boolean, required: true },
    reason: { type: String, default: '' }
  },
  { timestamps: true }
);

loginAttemptSchema.index({ createdAt: -1 });

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);
