const mongoose = require('mongoose');

// A plain, template-free CV — the "non-AI" CV Builder from the spec (AI-assisted
// generation is a separate, later phase that needs the user's own AI API key).
const resumeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    headline: { type: String, default: '' },
    summary: { type: String, default: '' },
    education: [
      {
        institution: String,
        degree: String,
        year: String
      }
    ],
    experience: [
      {
        title: String,
        company: String,
        duration: String,
        description: String
      }
    ],
    skills: [{ type: String }],
    languages: [{ type: String }],
    certifications: [{ type: String }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Resume', resumeSchema);
