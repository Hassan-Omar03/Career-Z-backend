const mongoose = require('mongoose');

// Idempotency ledger for inbound payment-gateway webhooks (spec 3A.3 "idempotency"). A gateway
// (Stripe, etc.) can and will retry a webhook delivery — the unique (provider, eventId) index is
// the actual idempotency guarantee: a duplicate insert throws E11000, which the webhook handler
// catches and treats as "already processed, skip" instead of double-crediting a payment.
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true }, // 'stripe'
    eventId: { type: String, required: true },
    type: { type: String, default: '' },
    processedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
