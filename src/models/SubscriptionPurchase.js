const mongoose = require('mongoose');

// One purchase = one 30-day period of a paid plan for one institution, paid via JazzCash. Mirrors
// FeaturedListing/CoursePurchase's pending->paid pattern so the webhook/sync path has a real
// record to verify the confirmed transaction against (ownership, plan, amount, currency).
const subscriptionPurchaseSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    plan: { type: String, enum: ['basic', 'professional', 'enterprise'], required: true },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'PKR' },
    // 'paddle' and paddleTransactionId are kept only for purchases made before JazzCash.
    paymentMethod: { type: String, enum: ['jazzcash', 'safepay', 'paddle', 'bank_transfer'], default: 'jazzcash' },
    paddleTransactionId: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    periodDays: { type: Number, default: 30 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionPurchase', subscriptionPurchaseSchema);
