// Real Paddle Billing REST API — CareerZ's primary worldwide gateway (cards, Apple Pay, Google
// Pay). No SDK needed — plain HTTPS, same pattern used for Meshy/HeyGen/Runway elsewhere in this
// codebase. CareerZ is the sole Merchant of Record Paddle sees; institutions are paid out
// separately/internally by CareerZ (see Fee.escrowStatus) — Paddle never auto-splits funds.
const crypto = require('crypto');
const env = require('../config/env');

function isPaddleConfigured() {
  return Boolean(env.paddle.apiKey && env.paddle.webhookSecret);
}

function baseUrl() {
  return env.paddle.environment === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

// Creates a "ready" transaction for a fully non-catalog (inline) item — no pre-created
// Paddle product/price needed, since every Fee has its own one-off amount/title.
async function createTransaction({ title, amount, currencyCode, customerEmail, metadata }) {
  const response = await fetch(`${baseUrl()}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.paddle.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [
        {
          quantity: 1,
          price: {
            description: title,
            name: title,
            tax_mode: 'account_setting',
            unit_price: { amount: String(Math.round(amount * 100)), currency_code: currencyCode },
            product: {
              name: title,
              tax_category: 'standard'
            }
          }
        }
      ],
      currency_code: currencyCode,
      customer: customerEmail ? { email: customerEmail } : undefined,
      custom_data: metadata
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.detail || payload.error?.type || `Paddle transaction create failed (${response.status}).`;
    const err = new Error(message);
    err.statusCode = response.status >= 500 ? 502 : 422;
    throw err;
  }
  return payload.data; // { id: 'txn_...', status: 'draft'|'ready'|..., ... }
}

async function getTransaction(transactionId) {
  const response = await fetch(`${baseUrl()}/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${env.paddle.apiKey}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error?.detail || `Paddle transaction fetch failed (${response.status}).`);
    err.statusCode = response.status >= 500 ? 502 : 422;
    throw err;
  }
  return payload.data;
}

// Paddle-Signature header: "ts=<unix>;h1=<hex hmac>". Verifies against the exact raw request
// body bytes — never against a JSON-parsed-and-restringified body.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(';').map((p) => p.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  // Reject stale signatures (replay protection) — 5 minute tolerance, generous enough to absorb
  // normal network/processing delay without weakening real replay protection.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const computed = crypto.createHmac('sha256', env.paddle.webhookSecret).update(signedPayload).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isPaddleConfigured, createTransaction, getTransaction, verifyWebhookSignature };
