const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    deviceInfo: { type: String, default: '' },
    ip: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
    revoked: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
