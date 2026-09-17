// Real Twilio REST API calls (no SDK — plain HTTPS, same approach used for Meshy/HeyGen/Runway
// elsewhere in this codebase) for SMS and WhatsApp (spec 15D.15). BYOK: each institution supplies
// its own Twilio Account SID + Auth Token via InstitutionCommsCredential; CareerZ never resells
// messaging or holds a shared Twilio account.
const InstitutionCommsCredential = require('../models/InstitutionCommsCredential');
const { encrypt, decrypt } = require('../utils/encryption');
const AppError = require('../utils/AppError');

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

async function saveCredential(institutionId, userId, { accountSid, authToken, smsFromNumber, whatsappFromNumber }) {
  const authTokenEncrypted = encrypt(authToken);
  return InstitutionCommsCredential.findOneAndUpdate(
    { institution: institutionId },
    { institution: institutionId, provider: 'twilio', accountSid, authTokenEncrypted, smsFromNumber: smsFromNumber || '', whatsappFromNumber: whatsappFromNumber || '', connectedBy: userId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function getStatus(institutionId) {
  const cred = await InstitutionCommsCredential.findOne({ institution: institutionId });
  if (!cred) return { configured: false };
  return { configured: true, provider: cred.provider, smsFromNumber: cred.smsFromNumber, whatsappFromNumber: cred.whatsappFromNumber };
}

async function removeCredential(institutionId) {
  await InstitutionCommsCredential.deleteOne({ institution: institutionId });
}

// Sends one real message via Twilio. channel: 'sms' | 'whatsapp'. Returns Twilio's own message
// SID on success, or throws with Twilio's real error message on failure (auth error, invalid
// number, unfunded trial account, etc.) — never fabricated success.
async function sendMessage(institutionId, channel, toPhone, body) {
  const cred = await InstitutionCommsCredential.findOne({ institution: institutionId });
  if (!cred) throw new AppError('No SMS/WhatsApp provider connected for this institution. Connect Twilio in Communication Center settings first.', 422);

  const authToken = decrypt(cred.authTokenEncrypted);
  const from = channel === 'whatsapp' ? cred.whatsappFromNumber : cred.smsFromNumber;
  if (!from) throw new AppError(`No ${channel} sender number configured for this institution.`, 422);
  const to = channel === 'whatsapp' ? `whatsapp:${toPhone.replace(/^whatsapp:/, '')}` : toPhone;

  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${cred.accountSid}:${authToken}`).toString('base64');

  const response = await fetch(`${TWILIO_BASE}/Accounts/${cred.accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(payload.message || `Twilio ${channel} send failed (${response.status}).`, response.status >= 500 ? 502 : 422);
  }
  return { sid: payload.sid, status: payload.status };
}

// Fans a message out to many phone numbers, never letting one bad number fail the whole batch.
async function sendBulk(institutionId, channel, toPhones, body) {
  const results = await Promise.allSettled(toPhones.map((phone) => sendMessage(institutionId, channel, phone, body)));
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  return { sent, failed };
}

module.exports = { saveCredential, getStatus, removeCredential, sendMessage, sendBulk };
