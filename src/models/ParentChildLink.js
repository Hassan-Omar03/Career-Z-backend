const mongoose = require('mongoose');

// Consent-based link between a Parent user and a Student user.
const parentChildLinkSchema = new mongoose.Schema(
  {
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relationship: { type: String, enum: ['father', 'mother', 'guardian', 'sponsor'], default: 'guardian' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

parentChildLinkSchema.index({ parent: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ParentChildLink', parentChildLinkSchema);
