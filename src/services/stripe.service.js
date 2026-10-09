const Stripe = require('stripe');
const env = require('../config/env');

let client = null;

// Lazily constructed so the app can boot without a Stripe key configured — callers check
// isStripeConfigured() first and return a clear error instead of a stack trace.
function getStripeClient() {
  if (!env.stripe.secretKey) return null;
  if (!client) client = new Stripe(env.stripe.secretKey);
  return client;
}

function isStripeConfigured() {
  return Boolean(env.stripe.secretKey && env.stripe.webhookSecret);
}

module.exports = { getStripeClient, isStripeConfigured };
