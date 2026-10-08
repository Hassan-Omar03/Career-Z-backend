const mongoose = require('mongoose');

// Real ledger entries — every balance change (top-up, withdrawal, transfer) is recorded here so
// Transaction History is genuine, never fabricated.
const walletTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['topup', 'withdrawal', 'transfer_in', 'transfer_out'], required: true },
    amount: { type: Number, required: true }, // always positive; type says direction
    currency: { type: String, required: true },
    // A unique, human-findable receipt id for THIS specific ledger entry — separate from any
    // gateway id (paddleTransactionId/nowPaymentsId), so every internal wallet-to-wallet move
    // (transfers, salary payouts) is independently searchable even though no gateway is involved.
    reference: { type: String, default: null, index: true },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'completed' },
    counterparty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // for transfers
    note: { type: String, default: '' },
    paddleTransactionId: { type: String, default: null },
    nowPaymentsId: { type: String, default: null },
    gatewayOrderId: { type: String, default: null },
    gatewayPriceAmount: { type: Number, default: null },
    gatewayPriceCurrency: { type: String, default: null },
    gatewayPayCurrency: { type: String, default: null },
    gatewayPayAmount: { type: Number, default: null },
    payoutMethod: { type: String, default: '' },
    payoutDetails: { type: String, default: '' },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Null values on transfers/withdrawals are excluded; a gateway transaction can credit once.
walletTransactionSchema.index({ paddleTransactionId: 1 }, {
  unique: true,
  partialFilterExpression: { paddleTransactionId: { $type: 'string' } }
});
walletTransactionSchema.index({ nowPaymentsId: 1 }, {
  unique: true,
  partialFilterExpression: { nowPaymentsId: { $type: 'string' } }
});

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
