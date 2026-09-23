const mongoose = require('mongoose');

// Institution<->Employer partnership (spec: "Institution placement office, employer
// partnerships, campus recruitment") — a real, consent-based relationship either side can
// request; referrals (PlacementReferral) can only be created once this is 'active'.
const institutionEmployerPartnershipSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, default: '' },
    status: { type: String, enum: ['requested', 'active', 'declined', 'ended'], default: 'requested' },
    respondedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

institutionEmployerPartnershipSchema.index(
  { institution: 1, employer: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active'] } } }
);

module.exports = mongoose.model('InstitutionEmployerPartnership', institutionEmployerPartnershipSchema);
