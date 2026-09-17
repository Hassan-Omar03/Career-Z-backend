const mongoose = require('mongoose');

// BYOK SMS/WhatsApp credentials (spec 15D.15) — same "institution brings its own provider
// account, CareerZ never resells messaging" pattern as AiCredential, but scoped to the
// institution (communication is sent on the institution's behalf, not a single user's).
// Twilio is the provider: one Account SID/Auth Token pair covers both SMS and WhatsApp
// (WhatsApp just uses a "whatsapp:+<number>" from-address on the same account).
const institutionCommsCredentialSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, unique: true, index: true },
    provider: { type: String, enum: ['twilio'], default: 'twilio' },
    accountSid: { type: String, required: true },
    authTokenEncrypted: { type: String, required: true },
    smsFromNumber: { type: String, default: '' },
    whatsappFromNumber: { type: String, default: '' }, // e.g. "whatsapp:+14155238886"
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InstitutionCommsCredential', institutionCommsCredentialSchema);
