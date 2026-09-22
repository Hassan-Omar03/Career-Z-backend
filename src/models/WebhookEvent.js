const mongoose = require('mongoose');

// A receipt is committed in the same transaction as its financial effects.
// Failed processing leaves no receipt, so the provider can safely retry.
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
