const mongoose = require('mongoose');

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    coverLetter: { type: String, default: '' },
    resumeSnapshot: { type: mongoose.Schema.Types.Mixed, default: null }, // copy of the Resume at time of applying
    status: {
      type: String,
      enum: ['pending', 'shortlisted', 'interview', 'rejected', 'hired'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

jobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
