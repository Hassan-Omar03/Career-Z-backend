const mongoose = require('mongoose');

const payoutProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  // 'stripe_transfer' is legacy (Stripe removed) — kept so old profiles load; no longer selectable.
  preferredMethod: { type: String, enum: ['platform_wallet', 'stripe_transfer', 'bank_transfer', 'mobile_wallet', 'crypto', 'cash'], default: 'platform_wallet' },
  bank: {
    accountTitle: { type: String, default: '' }, bankName: { type: String, default: '' },
    iban: { type: String, default: '' }, accountNumber: { type: String, default: '' }
  },
  mobileWallet: {
    provider: { type: String, default: '' }, accountTitle: { type: String, default: '' }, number: { type: String, default: '' }
  },
  crypto: {
    asset: { type: String, default: '' }, network: { type: String, default: '' }, address: { type: String, default: '' }
  }
}, { timestamps: true });

module.exports = mongoose.model('PayoutProfile', payoutProfileSchema);
