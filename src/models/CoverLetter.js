const mongoose = require('mongoose');

// A cover letter the person keeps and reuses when applying. Written by them (optionally started
// from their CV or drafted by their own AI provider); CareerZ never sends one on its own.
const MAX_LETTERS = 20;
const coverLetterSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    company: { type: String, default: '', trim: true, maxlength: 160 },
    role: { type: String, default: '', trim: true, maxlength: 160 },
    body: { type: String, required: true, maxlength: 8000 }
  },
  { timestamps: true }
);
coverLetterSchema.statics.MAX_LETTERS = MAX_LETTERS;

module.exports = mongoose.model('CoverLetter', coverLetterSchema);
