const mongoose = require('mongoose');

// Real campus-recruitment/placement tracking (spec: "campus recruitment/student referrals,
// placement tracking") — an institution recommends a real student for a real job at a partnered
// employer; the student still applies themselves (never auto-applied on their behalf), so this
// only ever tracks a recommendation through to a real JobApplication.
const placementReferralSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', default: null },
    status: { type: String, enum: ['referred', 'applied', 'hired', 'declined'], default: 'referred' },
    studentRespondedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

placementReferralSchema.index({ institution: 1, student: 1, job: 1 }, { unique: true });

module.exports = mongoose.model('PlacementReferral', placementReferralSchema);
