const mongoose = require('mongoose');

// Spec 11.15 "Parent incorrect event dispute kar sake" — a parent flags one specific scoring
// input (a PTM, a consent-link response, a notification, a fee) as wrong; once an institution
// upholds it, that exact record is excluded from the score computation going forward.
const reputationDisputeSchema = new mongoose.Schema(
  {
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    category: { type: String, enum: ['ptm', 'consent', 'notifications', 'fees'], required: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'upheld', 'rejected'], default: 'pending' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReputationDispute', reputationDisputeSchema);
