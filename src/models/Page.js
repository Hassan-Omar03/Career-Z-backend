const mongoose = require('mongoose');

// Static/CMS-managed website pages — About, Privacy Policy, Terms, Help Center, etc.
// (spec Part 16F.8 "Website Content Management System"). Super Admin edits these without
// touching code; the public site renders whatever is currently published.
const pageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '' }, // HTML/rich text, rendered as-is on the public page
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    seoTitle: { type: String, default: '' },
    seoDescription: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Page', pageSchema);
