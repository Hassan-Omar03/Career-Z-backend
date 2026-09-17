const mongoose = require('mongoose');

// Spec Part "Student Dashboard - #8 Virtual School Newsletter": Institution writes, Student +
// Parent read once published.
const newsletterSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    publishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Newsletter', newsletterSchema);
