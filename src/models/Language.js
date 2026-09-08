const mongoose = require('mongoose');

const languageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, lowercase: true }, // e.g. en, ur, ar
    direction: { type: String, enum: ['ltr', 'rtl'], default: 'ltr' },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Language', languageSchema);
