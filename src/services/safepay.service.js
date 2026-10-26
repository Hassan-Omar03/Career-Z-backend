const crypto = require('crypto');

// Safepay hosted checkout (cards, JazzCash, Easypaisa, bank/Raast), the same calls as Safepay's
// own Node SDK (@sfpy/node-sdk): create a tracker for the amount, send the payer to Safepay's
// page, and on return check the signature AND ask Safepay for the tracker's real state before
// anything is credited. Amounts are PKR in rupees.

const HOSTS = {
  sandbox: { api: 'https://sandbox.api.getsafepay.com', checkout: 'https://sandbox.api.getsafepay.com/checkout/pay' },
  production: { api: 'https://api.getsafepay.com', checkout: 'https://getsafepay.com/checkout/pay' }
};
// A tracker in one of these states has been paid.
const PAID_STATES = ['TRACKER_ENDED', 'TRACKER_COMPLETED', 'PAID'];
const FAILED_STATES = ['TRACKER_CANCELLED', 'TRACKER_FAILED', 'TRACKER_EXPIRED'];

function config() {
  const environment = process.env.SAFEPAY_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  return { environment, apiKey: process.env.SAFEPAY_API_KEY || '', secretKey: process.env.SAFEPAY_SECRET_KEY || '', ...HOSTS[environment] };
}
const isConfigured = () => { const c = config(); return Boolean(c.apiKey && c.secretKey); };

async function call(path, options = {}) {
  const c = config();
  const res = await fetch(c.api + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.data) {
    const err = new Error(body?.status?.errors?.[0] || body?.message || `Safepay request failed (${res.status}).`);
    err.statusCode = 502;
    throw err;
  }
  return body.data;
}

// A new checkout tracker for `amount` rupees.
async function createTracker(amount) {
  const c = config();
  const data = await call('/order/v1/init', { method: 'POST', body: JSON.stringify({ client: c.apiKey, amount, currency: 'PKR', environment: c.environment }) });
  if (!data.token) throw Object.assign(new Error('Safepay did not return a checkout token.'), { statusCode: 502 });
  return data.token;
}

function checkoutUrl({ tracker, orderId, redirectUrl, cancelUrl }) {
  const c = config();
  const q = new URLSearchParams({ beacon: tracker, cancel_url: cancelUrl, env: c.environment, order_id: orderId, redirect_url: redirectUrl, source: 'custom', webhooks: 'false' });
  return `${c.checkout}?${q}`;
}

// The return signature: HMAC-SHA256 of the tracker with the secret key.
function verifySignature(tracker, sig) {
  if (!tracker || !sig || !isConfigured()) return false;
  const expected = crypto.createHmac('sha256', config().secretKey).update(String(tracker)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Safepay's own record of the tracker — the source of truth for whether it was paid.
async function fetchTracker(tracker) {
  return call(`/order/v1/${encodeURIComponent(tracker)}`, { headers: { 'X-SFPY-MERCHANT-SECRET': config().secretKey } });
}

// 'paid' / 'failed' / 'awaiting_payment' for a tracker that belongs to us and is for `amount` PKR.
function outcomeOf(data, amount) {
  const c = config();
  if (!data || data.client !== c.apiKey || data.currency !== 'PKR' || Math.abs(Number(data.amount) - Number(amount)) > 0.009) return 'mismatch';
  if (PAID_STATES.includes(data.state)) return 'paid';
  if (FAILED_STATES.includes(data.state)) return 'failed';
  return 'awaiting_payment';
}

module.exports = { config, isConfigured, createTracker, checkoutUrl, verifySignature, fetchTracker, outcomeOf };
