const mongoose = require('mongoose');

// Consent-based link between a Parent user and a Student user.
const parentChildLinkSchema = new mongoose.Schema(
  {
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relationship: { type: String, enum: ['father', 'mother', 'guardian', 'sponsor'], default: 'guardian' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approvedAt: { type: Date, default: null },
    // Extra institution-side check on top of student consent — e.g. matches admission records —
    // settable only by the student's institution (spec: Institution<->Parent "guardian verification").
    institutionVerified: { type: Boolean, default: false },
    institutionVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    institutionVerifiedAt: { type: Date, default: null },
    // Detailed guardian/custody permission levels (spec) — the student is the account holder who
    // consents to being linked at all, so they're also the one who can narrow what a specific
    // guardian can do beyond the relationship-type default. A 'sponsor' defaults more restricted
    // (matches the existing GUARDIAN_RELATIONSHIPS rule); father/mother/guardian default to full.
    permissions: {
      payFees: { type: Boolean, default: true },
      viewHealth: { type: Boolean, default: true },
      giveConsent: { type: Boolean, default: true }
    }
  },
  { timestamps: true }
);

parentChildLinkSchema.index({ parent: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ParentChildLink', parentChildLinkSchema);
