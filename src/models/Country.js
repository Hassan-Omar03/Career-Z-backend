const mongoose = require('mongoose');

const countrySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, uppercase: true }, // ISO-2, e.g. PK, SA, US
    dialCode: { type: String, default: '' },
    defaultCurrency: { type: String, default: '' }, // Currency.code
    defaultLanguage: { type: String, default: 'en' }, // Language.code
    timeZone: { type: String, default: 'UTC' },
    dateFormat: { type: String, default: 'DD/MM/YYYY' },
    active: { type: Boolean, default: true },
    hidden: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Country', countrySchema);
