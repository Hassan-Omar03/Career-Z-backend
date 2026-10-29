const mongoose = require('mongoose');

// Master 12.16: an employee reviews the company they really worked for (one review per
// employment). Automatic checks hold suspicious reviews for an admin's evidence review; the
// employer may answer or report a review, and whichever side loses a decision may appeal once.
const companyReviewSchema = new mongoose.Schema(
  {
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employment: { type: mongoose.Schema.Types.ObjectId, ref: 'Employment', required: true, unique: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '' },
    comment: { type: String, required: true },
    salaryOnTime: { type: Boolean, default: null },
    evidenceNote: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'published', 'hidden'], default: 'pending', index: true },
    flags: [{ code: String, label: String, _id: false }],
    aiCheck: { verdict: { type: String, default: '' }, reason: { type: String, default: '' }, at: { type: Date, default: null } },
    moderation: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, note: { type: String, default: '' } },
    employerResponse: { text: { type: String, default: '' }, at: { type: Date, default: null } },
    report: { reason: { type: String, default: '' }, at: { type: Date, default: null }, open: { type: Boolean, default: false } },
    appeal: {
      by: { type: String, enum: ['', 'reviewer', 'employer'], default: '' },
      text: { type: String, default: '' },
      at: { type: Date, default: null },
      status: { type: String, enum: ['', 'pending', 'upheld', 'rejected'], default: '' },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      decidedAt: { type: Date, default: null },
      note: { type: String, default: '' }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanyReview', companyReviewSchema);
