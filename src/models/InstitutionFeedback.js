const mongoose = require('mongoose');

// A parent's satisfaction rating of an institution — accepted only from a parent with a real,
// approved link to a student actually enrolled there (see parent.controller.js). One rating per
// parent per institution; resubmitting updates it rather than creating a duplicate.
const institutionFeedbackSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' }
  },
  { timestamps: true }
);

institutionFeedbackSchema.index({ institution: 1, fromUser: 1 }, { unique: true });

module.exports = mongoose.model('InstitutionFeedback', institutionFeedbackSchema);
