const mongoose = require('mongoose');

// A real admissions application workflow — distinct from StudentProfile.primaryInstitution
// (the instant "connect to institution" used once a student is already enrolled). This is
// the pre-enrollment pipeline a Representative works: submit, review, request documents, decide.
const institutionApplicationSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    program: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'under_review', 'documents_required', 'accepted', 'rejected'],
      default: 'draft'
    },
    documents: [
      {
        name: String,
        url: String,
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
      }
    ],
    missingRequirements: [{ type: String }],
    assignedRepresentative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
    submittedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InstitutionApplication', institutionApplicationSchema);
