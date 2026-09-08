const mongoose = require('mongoose');

const scholarshipApplicationSchema = new mongoose.Schema(
  {
    scholarship: { type: mongoose.Schema.Types.ObjectId, ref: 'Scholarship', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    statement: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedAt: { type: Date }
  },
  { timestamps: true }
);

scholarshipApplicationSchema.index({ scholarship: 1, applicant: 1 }, { unique: true });

module.exports = mongoose.model('ScholarshipApplication', scholarshipApplicationSchema);
