const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema(
  {
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subject: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['harassment', 'fraud', 'technical', 'billing', 'content', 'other'],
      default: 'other'
    },
    description: { type: String, required: true },
    targetType: { type: String, enum: ['user', 'institution', 'job', 'product', 'none'], default: 'none' },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ['open', 'in_review', 'resolved', 'dismissed'], default: 'open' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Complaint', complaintSchema);
