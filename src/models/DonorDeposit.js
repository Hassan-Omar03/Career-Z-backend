const mongoose = require('mongoose');

// A donor's request to fund their wallet — this platform has no real payment processor
// anywhere, so this tracks the request/confirmation honestly; it doesn't move real money.
const donorDepositSchema = new mongoose.Schema(
  {
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other'], required: true },
    status: { type: String, enum: ['requested', 'confirmed', 'rejected'], default: 'requested' },
    transactionId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DonorDeposit', donorDepositSchema);
