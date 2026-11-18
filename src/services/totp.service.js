const crypto = require('crypto');
const { encrypt, decrypt } = require('../utils/encryption');

// Authenticator-app two-factor sign-in (master 5.7: Email OTP, SMS OTP, Authenticator App, Passkey).
// RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits — what Google Authenticator, Microsoft
// Authenticator and similar apps use. The secret is stored encrypted; each code works once.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// The matching step within one step either side (phone clocks drift), or null.
function matchStep(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepNow(now);
  for (const d of [0, -1, 1]) {
    const a = Buffer.from(codeAt(secret, s + d)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s + d;
  }
  return null;
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }
function otpauthUrl(secret, email) {
  const label = encodeURIComponent(`CareerZ:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=CareerZ&algorithm=SHA1&digits=6&period=${STEP}`;
}

const hashBackup = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newBackupCodes(n = 8) {
  const codes = Array.from({ length: n }, () => { const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); return `${raw.slice(0, 5)}-${raw.slice(5)}`; });
  return { codes, hashes: codes.map(hashBackup) };
}

// Checks a login code for a user loaded with +totp fields. A used authenticator step or backup
// code cannot be used again. Saves the user when a code is accepted.
async function verifyUserCode(user, code) {
  if (!user.totp?.secret) return false;
  // Five wrong codes in a row lock the account's code check for 15 minutes, from any address.
  if (user.totp.lockedUntil && user.totp.lockedUntil > new Date()) throw new (require('../utils/AppError'))('Too many wrong codes. Wait 15 minutes and try again.', 429);
  const ok = await check(user, code);
  user.totp.failures = ok ? 0 : (user.totp.failures || 0) + 1;
  if (user.totp.failures >= 5) { user.totp.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); user.totp.failures = 0; }
  await user.constructor.updateOne({ _id: user._id }, { $set: { 'totp.failures': user.totp.failures, 'totp.lockedUntil': user.totp.lockedUntil || null } });
  return ok;
}

async function check(user, code) {
  const secret = decrypt(user.totp.secret);
  const step = matchStep(secret, code);
  if (step !== null) {
    // Claimed in one database write, so two requests with the same code cannot both pass.
    const claimed = await user.constructor.updateOne({ _id: user._id, $or: [{ 'totp.lastStep': null }, { 'totp.lastStep': { $lt: step } }] }, { $set: { 'totp.lastStep': step } });
    if (!claimed.modifiedCount) return false;
    user.totp.lastStep = step;
    return true;
  }
  const h = hashBackup(code);
  const idx = (user.totp.backupCodes || []).indexOf(h);
  if (idx === -1 || !String(code).replace(/[^A-Za-z0-9]/g, '').match(/^[A-Za-z0-9]{10}$/)) return false;
  const used = await user.constructor.updateOne({ _id: user._id, 'totp.backupCodes': h }, { $pull: { 'totp.backupCodes': h } });
  if (!used.modifiedCount) return false;
  user.totp.backupCodes.splice(idx, 1);
  return true;
}

module.exports = { newSecret, otpauthUrl, matchStep, codeAt, stepNow, newBackupCodes, hashBackup, verifyUserCode, encrypt, decrypt };
