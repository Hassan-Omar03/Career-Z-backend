const mongoose = require('mongoose');

const roleRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestedRole: { type: String, required: true },
    documents: [{ type: String }], // file URLs/paths uploaded as evidence
    notes: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending'
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNotes: { type: String, default: '' },
    reviewedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RoleRequest', roleRequestSchema);
