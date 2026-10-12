const mongoose = require('mongoose');

// Named CV versions (e.g. "Software internship", "Teaching assistant") alongside the main
// Resume. A student keeps up to MAX_VARIANTS; one may be the default sent with applications.
const MAX_VARIANTS = 5;
const variantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    targetRole: { type: String, default: '', trim: true, maxlength: 120 },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    isDefault: { type: Boolean, default: false },
    headline: { type: String, default: '', maxlength: 160 },
    summary: { type: String, default: '', maxlength: 3000 },
    location: { type: String, default: '', maxlength: 160 },
    education: [{ institution: String, degree: String, year: String }],
    experience: [{ title: String, company: String, duration: String, description: String }],
    skills: [{ type: String }],
    languages: [{ type: String }],
    certifications: [{ type: String }],
    portfolio: [{ title: String, url: String, description: String }]
  },
  { timestamps: true }
);
variantSchema.index({ user: 1, name: 1 }, { unique: true });
variantSchema.statics.MAX_VARIANTS = MAX_VARIANTS;

module.exports = mongoose.model('ResumeVariant', variantSchema);
