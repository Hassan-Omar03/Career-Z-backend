// Real NOWPayments REST API — crypto wallet top-ups (USDT TRC20 / BTC / ETH). Same "empty key =
// not configured" pattern as paddle.service.js. NOWPayments settles a payment
// asynchronously (customer sends crypto, network confirms, IPN webhook fires "finished") — the
// checkout call below never credits anything itself.
const crypto = require('crypto');
const env = require('../config/env');

const BASE_URL = 'https://api.nowpayments.io/v1';
const SUPPORTED_CURRENCIES = { usdttrc20: 'USDT (TRC20)', btc: 'Bitcoin (BTC)', eth: 'Ethereum (ETH)' };

function isNowPaymentsConfigured() {
  return Boolean(env.nowPayments.apiKey && env.nowPayments.ipnSecret);
}

// Creates a hosted-invoice-style payment. `payCurrency` must be one of SUPPORTED_CURRENCIES.
async function createPayment({ priceAmount, priceCurrency, payCurrency, orderId, orderDescription, ipnCallbackUrl }) {
  const response = await fetch(`${BASE_URL}/payment`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'x-api-key': env.nowPayments.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: priceAmount,
      price_currency: priceCurrency.toLowerCase(),
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: orderDescription,
      ipn_callback_url: ipnCallbackUrl
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.message || `NOWPayments payment create failed (${response.status}).`);
    err.statusCode = response.status >= 500 ? 502 : 422;
    throw err;
  }
  return payload; // { payment_id, pay_address, pay_amount, pay_currency, payment_status, ... }
}

async function getPaymentStatus(paymentId) {
  const response = await fetch(`${BASE_URL}/payment/${paymentId}`, {
    headers: { 'x-api-key': env.nowPayments.apiKey }, signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.message || `NOWPayments status fetch failed (${response.status}).`);
    err.statusCode = response.status >= 500 ? 502 : 422;
    throw err;
  }
  return payload;
}

// IPN signature: HMAC-SHA512 of the JSON body with keys sorted alphabetically (NOWPayments' own
// documented rule — an unsorted/raw-body hash will never match), hex digest, header x-nowpayments-sig.
function verifyIpnSignature(parsedBody, signatureHeader) {
  if (!signatureHeader || !parsedBody || typeof parsedBody !== 'object') return false;
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  const sorted = canonical(parsedBody);
  const computed = crypto.createHmac('sha512', env.nowPayments.ipnSecret).update(JSON.stringify(sorted)).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(String(signatureHeader), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isNowPaymentsConfigured, createPayment, getPaymentStatus, verifyIpnSignature, SUPPORTED_CURRENCIES };
