const mongoose = require('mongoose');

const coursePurchaseSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['stripe', 'paddle', 'jazzcash'], required: true }, // 'stripe' = legacy purchases only
  providerCheckoutId: { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  // Set only when the gateway charged in a DIFFERENT currency than `currency` (e.g. Paddle
  // doesn't accept PKR, so the course was actually billed in converted USD) — the webhook
  // verifies the payload against these instead, while the purchase itself stays in `currency`.
  gatewayAmountMinor: { type: Number, default: null },
  gatewayCurrency: { type: String, default: null },
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date, default: null },
  providerPaymentId: { type: String, default: null }
}, { timestamps: true });

coursePurchaseSchema.index({ provider: 1, providerCheckoutId: 1 }, { unique: true });
module.exports = mongoose.model('CoursePurchase', coursePurchaseSchema);
