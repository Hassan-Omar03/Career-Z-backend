const mongoose = require('mongoose');

// A request to cash out "available" commission balance — this platform has no real payment
// processor anywhere, so this tracks the request/approval lifecycle honestly; it doesn't move
// real money. commissions[] are marked 'paid' once the withdrawal itself is marked 'paid'.
const withdrawalSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    commissions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Commission' }],
    // How the agent wants to receive this payout, and their account reference — provided at
    // request time so whoever processes it knows where to send the money.
    payoutMethod: { type: String, enum: ['bank_transfer', 'mobile_wallet', 'other'], required: true },
    payoutDetails: { type: String, required: true, trim: true },
    status: { type: String, enum: ['requested', 'processing', 'paid', 'rejected'], default: 'requested' },
    transactionId: { type: String, default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
