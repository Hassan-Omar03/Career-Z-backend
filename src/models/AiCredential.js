const mongoose = require('mongoose');

// BYOK (Bring Your Own Key) AI credentials — spec Part 14/17E: "CareerZ خود کوئی AI Model فروخت
// نہیں کرے گا... ہر ادارہ اپنی API Key لگائے گا... Billing وہ خود ادا کرے گا." A user can connect
// multiple providers at once, one per "purpose" — e.g. OpenAI for text AND Meshy for 3D models
// AND ElevenLabs for voice, all simultaneously (spec's "AI Creative Teacher" needs several
// different AI categories working together). The key itself is never stored in plain text — see
// utils/encryption.js.
const aiCredentialSchema = new mongoose.Schema(
  {
    // 'user' scope: a personal key, usable only by the connecting user.
    // 'institution' scope: the institution's own key — any staff member with the 'ai:use'
    // permission (or the owner) can use it, billed to the institution's own provider account.
    scope: { type: String, enum: ['user', 'institution'], default: 'user' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // connector/manager either way
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
    purpose: { type: String, enum: ['text', 'image', 'threed', 'voice', 'avatar', 'animation'], required: true },
    provider: { type: String, required: true }, // e.g. 'openai','claude' (text); 'openai','stability' (image); 'meshy' (threed); 'elevenlabs' (voice); 'heygen' (avatar); 'runway' (animation)
    apiKeyEncrypted: { type: String, required: true },
    // A short, non-reversible display hint computed once from the plaintext key before it's
    // encrypted (e.g. "sk-...4f2a") — lets the UI show "a key is connected, here's which one"
    // without ever being able to reconstruct the real key from it.
    keyPreview: { type: String, default: '' },
    model: { type: String, default: '' } // optional override; provider default used if blank
  },
  { timestamps: true }
);

// A user has at most one personal credential per purpose; an institution has at most one
// institution-owned credential per purpose. Partial indexes so the two scopes don't collide.
aiCredentialSchema.index({ user: 1, purpose: 1 }, { unique: true, partialFilterExpression: { scope: 'user' } });
aiCredentialSchema.index({ institution: 1, purpose: 1 }, { unique: true, partialFilterExpression: { scope: 'institution' } });

module.exports = mongoose.model('AiCredential', aiCredentialSchema);
