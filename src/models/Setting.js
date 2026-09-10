const mongoose = require('mongoose');

// A small generic key/value store for Super-Admin-controlled platform settings that aren't
// simple on/off flags (see FeatureFlag for those) — e.g. the commission rate percentage.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
