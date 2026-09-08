const mongoose = require('mongoose');

const featureFlagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // e.g. 'jobs', 'marketplace', 'donations'
    label: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    scope: { type: String, enum: ['global', 'country', 'institution'], default: 'global' },
    scopeValue: { type: String, default: null } // country code or institution id, when scope != global
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeatureFlag', featureFlagSchema);
