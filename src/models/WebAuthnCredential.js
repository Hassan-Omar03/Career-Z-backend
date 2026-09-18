const mongoose = require('mongoose');

// WebAuthn/Passkey credentials (spec: "online fingerprint / device biometric verification" via
// WebAuthn — fingerprint sensors, Windows Hello, Face ID, etc.). CareerZ never sees or stores any
// biometric data — the device itself performs the biometric check and hands back only a
// public-key credential + a cryptographic signature, which is what's stored/verified here.
const webAuthnCredentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    credentialId: { type: String, required: true, unique: true }, // base64url, from the authenticator
    publicKey: { type: String, required: true }, // base64url-encoded COSE public key
    counter: { type: Number, default: 0 }, // replay-protection signature counter
    deviceType: { type: String, default: '' }, // 'singleDevice' | 'multiDevice' (per WebAuthn spec)
    backedUp: { type: Boolean, default: false },
    transports: [{ type: String }], // e.g. 'internal', 'hybrid'
    label: { type: String, default: '' } // e.g. "Windows Hello", set at registration time
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebAuthnCredential', webAuthnCredentialSchema);
