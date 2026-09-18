const mongoose = require('mongoose');

// Transient challenge storage between "generate options" and "verify response" — kept in Mongo
// (not an in-memory Map) because the backend runs as stateless serverless functions, so the two
// requests of one WebAuthn ceremony can land on different instances. TTL-indexed so Mongo itself
// garbage-collects expired challenges.
const webAuthnChallengeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['registration', 'authentication'], required: true },
    challenge: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 300 } // 5 minutes
  },
  { timestamps: false }
);

module.exports = mongoose.model('WebAuthnChallenge', webAuthnChallengeSchema);
