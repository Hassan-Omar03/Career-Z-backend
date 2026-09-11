const mongoose = require('mongoose');

// A marketplace seller's request to cash out their available (net, post-commission) earnings.
// No real payment processor in this app — this tracks the request/approval lifecycle honestly,
// same pattern as the Education Agent's Withdrawal model; it doesn't move real money.
const sellerWithdrawalSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['requested', 'processing', 'paid', 'rejected'], default: 'requested' },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SellerWithdrawal', sellerWithdrawalSchema);
