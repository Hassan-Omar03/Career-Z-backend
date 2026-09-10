const mongoose = require('mongoose');

// A student, institution, or project asking for funding — donors browse/get recommended
// these and can Donate Now / Sponsor Student against them. Distinct from Scholarship (which
// is donor-initiated); this is the reverse direction — requester-initiated.
const fundingRequestSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestType: { type: String, enum: ['student', 'institution', 'project'], required: true }, // who's asking
    // What the funding is for — the 6 browsable categories, a separate dimension from requestType.
    category: {
      type: String,
      enum: ['scholarship', 'course_fee', 'institution_support', 'education_project', 'learning_resources', 'emergency_assistance'],
      required: true
    },
    educationLevel: { type: String, enum: ['primary', 'secondary', 'undergraduate', 'graduate', 'vocational', ''], default: '' },
    title: { type: String, required: true, trim: true },
    purpose: { type: String, default: '' },
    requiredAmount: { type: Number, required: true, min: 0 },
    collectedAmount: { type: Number, default: 0 }, // incremented as real Donations come in
    currency: { type: String, default: 'USD' },
    country: { type: String, default: '' },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    applicationDeadline: { type: Date, default: null },
    documents: [{ name: String, url: String }], // supporting evidence — paste-a-URL, no file storage service
    verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    status: { type: String, enum: ['open', 'closed', 'fulfilled'], default: 'open' },
    // The donor-facing review pipeline for this request — separate from `status` (open/closed/fulfilled,
    // system-driven by funding progress) and `verificationStatus` (admin-only authenticity check).
    // partially_funded/funded are kept in sync automatically as real donations come in; new/under_review/
    // approved/rejected are set by a donor reviewing the request.
    applicationStatus: {
      type: String,
      enum: ['new', 'under_review', 'approved', 'partially_funded', 'funded', 'rejected'],
      default: 'new'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FundingRequest', fundingRequestSchema);
