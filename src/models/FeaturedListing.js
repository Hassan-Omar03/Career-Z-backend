const mongoose = require('mongoose');

// Revenue ledger for "Featured" purchases (Part 4.26 Premium Promotion Engine). Real, computed
// entries — the amount is a snapshot of the configured fee at purchase time, so changing the fee
// later never rewrites what a past purchase actually cost. No real payment gateway exists yet
// anywhere in this app (see Marketplace's computeEarnings for the same honest pattern), so this
// is a ledger of money owed/recorded, not a claim that a card was actually charged.
const featuredListingSchema = new mongoose.Schema(
  {
    listingType: { type: String, enum: ['job'], default: 'job' },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other'], required: true },
    transactionId: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeaturedListing', featuredListingSchema);
