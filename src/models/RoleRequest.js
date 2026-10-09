const mongoose = require('mongoose');

// One account type's verification request (user + role) — the single source of truth for whether
// that role is admin-approved (utils/roleVerification.js, services/accountGate.service.js).
//
// awaiting_documents → pending_approval → under_review → approved | rejected | resubmission_required
// (→ pending_approval again); approved ⇄ suspended. 'pending' is the legacy name of
// pending_approval and is treated identically everywhere.
const roleRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestedRole: { type: String, required: true },
    // individual / organization (donor), individual / business (marketplace), individual / agency (agent)
    subtype: { type: String, default: '' },
    documents: [{ type: String }], // legacy: file URLs uploaded before private document storage
    notes: { type: String, default: '' },
    status: {
      type: String,
      enum: ['awaiting_documents', 'pending', 'pending_approval', 'under_review', 'approved', 'rejected', 'resubmission_required', 'suspended'],
      default: 'pending'
    },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNotes: { type: String, default: '' }, // rejection / resubmission / suspension reason
    reviewedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resubmissionDocuments: [{ type: String }], // document types the admin asked to be re-uploaded
    legacy: { type: Boolean, default: false } // account that existed before mandatory verification
  },
  { timestamps: true }
);

roleRequestSchema.index({ user: 1, requestedRole: 1 });

module.exports = mongoose.model('RoleRequest', roleRequestSchema);
