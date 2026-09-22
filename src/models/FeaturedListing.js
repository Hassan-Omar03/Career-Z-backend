const mongoose = require('mongoose');

// Revenue ledger for "Featured" purchases (Part 4.26 Premium Promotion Engine). Real, computed
// entries — the amount is a snapshot of the configured fee at purchase time, so changing the fee
// later never rewrites what a past purchase actually cost. Card payments go through Paddle (see
// payment.controller.js createFeaturedJobCheckout) and are only recorded once the webhook
// confirms the transaction actually completed; paymentMethod values other than 'paddle' are a
// manual/admin-recorded off-platform payment (bank transfer, cash), same honest self-report
// pattern used for institution fees.
const featuredListingSchema = new mongoose.Schema(
  {
    listingType: { type: String, enum: ['job'], default: 'job' },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other', 'paddle'], required: true },
    transactionId: { type: String, default: null },
    paddleTransactionId: { type: String, default: null, unique: true, sparse: true },
    status: { type: String, enum: ['pending', 'paid'], default: 'paid' }, // paddle purchases start 'pending'; manual entries are 'paid' immediately
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeaturedListing', featuredListingSchema);
