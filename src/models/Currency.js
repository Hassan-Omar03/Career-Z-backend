const mongoose = require('mongoose');

const currencySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, uppercase: true }, // e.g. PKR, USD
    symbol: { type: String, required: true },
    symbolPosition: { type: String, enum: ['left', 'right'], default: 'left' },
    decimalPlaces: { type: Number, default: 2 },
    exchangeRateToUSD: { type: Number, default: 1 }, // updated via configured rate feed
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Currency', currencySchema);
