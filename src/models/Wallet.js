const mongoose = require('mongoose');

// One real balance ledger per (user, currency) — Available (usable now) vs Pending (topped-up
// but not yet confirmed, or withdrawal-in-progress). Real money only ever enters via a confirmed
// Paddle webhook (see webhook.controller.js) — never incremented on a client-side claim.
const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    currency: { type: String, required: true },
    available: { type: Number, default: 0 },
    pending: { type: Number, default: 0 }
  },
  { timestamps: true }
);

walletSchema.index({ user: 1, currency: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
