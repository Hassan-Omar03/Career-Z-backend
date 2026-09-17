const mongoose = require('mongoose');

// A real, individual contribution toward a FundingRequest — "Donate Now" (one-time) or
// "Sponsor Student" (an ongoing commitment) both create one of these, distinguished by `type`.
const donationSchema = new mongoose.Schema(
  {
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Denormalized at creation from fundingRequest.requestedBy — the receipt's "receiver" (spec
    // 3A.2) stays stable even if the underlying request is later edited or reassigned.
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fundingRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FundingRequest', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    type: { type: String, enum: ['donation', 'sponsorship'], default: 'donation' },
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other'], default: 'other' },
    // Internal ledger reference — this app has no real payment gateway, so this is a real,
    // unique, server-generated tracking id, not a fabricated external transaction number.
    transactionId: { type: String, unique: true, index: true },
    // Full receipt breakdown (spec 3A.2) — see Fee.js for why gatewayCharges/taxAmount stay 0.
    grossAmount: { type: Number, default: null },
    platformCommission: { type: Number, default: 0 },
    gatewayCharges: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: null },
    // Escrow (spec 3A.3) — see Fee.js for the same honesty note on what "held" actually means here.
    escrowStatus: { type: String, enum: ['none', 'held', 'released'], default: 'held' },
    escrowReleasedAt: { type: Date, default: null },
    escrowReleasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // successful by default: recorded the moment the donor confirms it happened (no live payment
    // processor). The donor can later self-report failed/refunded if the real-world payment didn't
    // go through or was reversed — collectedAmount is reconciled accordingly.
    status: { type: String, enum: ['pending', 'successful', 'failed', 'refunded'], default: 'successful' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Donation', donationSchema);
