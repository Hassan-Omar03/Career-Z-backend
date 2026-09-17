const crypto = require('crypto');
const env = require('../config/env');

// AES-256-GCM — real encryption at rest for user-owned secrets (BYOK AI API keys). The key is
// derived once via scrypt so env.encryptionKey (any length string) becomes a proper 32-byte key.
const KEY = crypto.scryptSync(env.encryptionKey, 'careerz_static_salt', 32);

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
