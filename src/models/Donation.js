const mongoose = require('mongoose');

// A real, individual contribution toward a FundingRequest — "Donate Now" (one-time) or
// "Sponsor Student" (an ongoing commitment) both create one of these, distinguished by `type`.
const donationSchema = new mongoose.Schema(
  {
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fundingRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FundingRequest', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    type: { type: String, enum: ['donation', 'sponsorship'], default: 'donation' },
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other'], default: 'other' },
    // Internal ledger reference — this app has no real payment gateway, so this is a real,
    // unique, server-generated tracking id, not a fabricated external transaction number.
    transactionId: { type: String, unique: true, index: true },
    // successful by default: recorded the moment the donor confirms it happened (no live payment
    // processor). The donor can later self-report failed/refunded if the real-world payment didn't
    // go through or was reversed — collectedAmount is reconciled accordingly.
    status: { type: String, enum: ['pending', 'successful', 'failed', 'refunded'], default: 'successful' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Donation', donationSchema);
