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
    status: { type: String, enum: ['requested', 'processing', 'paid', 'rejected'], default: 'requested' },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
