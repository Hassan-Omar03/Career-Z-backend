const mongoose = require('mongoose');

// BYOK (Bring Your Own Key) AI credentials — spec Part 14/17E: "CareerZ خود کوئی AI Model فروخت
// نہیں کرے گا... ہر ادارہ اپنی API Key لگائے گا... Billing وہ خود ادا کرے گا." A user can connect
// multiple providers at once, one per "purpose" — e.g. OpenAI for text AND Meshy for 3D models
// AND ElevenLabs for voice, all simultaneously (spec's "AI Creative Teacher" needs several
// different AI categories working together). The key itself is never stored in plain text — see
// utils/encryption.js.
const aiCredentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['text', 'image', 'threed', 'voice', 'avatar', 'animation'], required: true },
    provider: { type: String, required: true }, // e.g. 'openai','claude' (text); 'openai','stability' (image); 'meshy' (threed); 'elevenlabs' (voice); 'heygen' (avatar); 'runway' (animation)
    apiKeyEncrypted: { type: String, required: true },
    model: { type: String, default: '' } // optional override; provider default used if blank
  },
  { timestamps: true }
);

aiCredentialSchema.index({ user: 1, purpose: 1 }, { unique: true });

module.exports = mongoose.model('AiCredential', aiCredentialSchema);
