const mongoose = require('mongoose');

// One purchase = one 30-day period of a paid plan for one institution, paid via Paddle. Mirrors
// FeaturedListing/CoursePurchase's pending->paid pattern so the webhook/sync path has a real
// record to verify the confirmed transaction against (ownership, plan, amount, currency).
const subscriptionPurchaseSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    plan: { type: String, enum: ['basic', 'professional', 'enterprise'], required: true },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    paymentMethod: { type: String, enum: ['paddle'], default: 'paddle' },
    paddleTransactionId: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    periodDays: { type: Number, default: 30 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionPurchase', subscriptionPurchaseSchema);
