// WebAuthn/Passkey config — device biometric verification (Windows Hello, Face ID, fingerprint
// sensors) via the browser's built-in platform authenticator. CareerZ never receives or stores
// any biometric data; the device performs the check and returns a signed, public-key assertion,
// which is all this ever verifies. Requires a secure context (HTTPS, or localhost for dev).
const env = require('../config/env');

function getRpConfig() {
  const url = new URL(env.clientUrl.split(',')[0].trim());
  return {
    rpName: 'CareerZ',
    rpID: url.hostname, // e.g. 'localhost' in dev, the real domain in production
    origin: `${url.protocol}//${url.host}`
  };
}

module.exports = { getRpConfig };
