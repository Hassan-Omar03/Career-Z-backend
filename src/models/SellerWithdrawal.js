const mongoose = require('mongoose');

// A marketplace seller's request to cash out their available (net, post-commission) earnings.
// No real payment processor in this app — this tracks the request/approval lifecycle honestly,
// same pattern as the Education Agent's Withdrawal model; it doesn't move real money.
const sellerWithdrawalSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    // How the seller wants to receive this payout, and their account reference — provided at
    // request time so whoever processes it knows where to send the money.
    payoutMethod: { type: String, enum: ['bank_transfer', 'mobile_wallet', 'other'], required: true },
    payoutDetails: { type: String, required: true, trim: true },
    status: { type: String, enum: ['requested', 'processing', 'paid', 'rejected'], default: 'requested' },
    transactionId: { type: String, default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SellerWithdrawal', sellerWithdrawalSchema);
