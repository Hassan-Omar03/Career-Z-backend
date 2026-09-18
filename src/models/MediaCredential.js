const mongoose = require('mongoose');

// BYOK media storage — the AI Video Lesson Creator's rendered MP4 (built client-side, ffmpeg.wasm)
// needs somewhere real to live so "student watches it through CareerZ" is actually true. Free
// tier (Cloudinary: 25GB storage/bandwidth) — the institution owns the account, CareerZ never
// stores or resells media hosting.
const mediaCredentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    provider: { type: String, enum: ['cloudinary'], default: 'cloudinary' },
    cloudName: { type: String, required: true },
    apiKey: { type: String, required: true },
    apiSecretEncrypted: { type: String, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MediaCredential', mediaCredentialSchema);
