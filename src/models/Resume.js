const mongoose = require('mongoose');

// A plain, template-free CV — the "non-AI" CV Builder from the spec (AI-assisted
// generation is a separate, later phase that needs the user's own AI API key).
const resumeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    headline: { type: String, default: '' }, // doubles as "Professional title" on the job-seeker dashboard
    summary: { type: String, default: '' },
    location: { type: String, default: '' },
    experienceLevel: { type: String, enum: ['entry', 'mid', 'senior', 'lead', ''], default: '' },
    linkedinUrl: { type: String, default: '' },
    // No file storage service is wired up — same paste-a-link pattern as User.profilePhoto.
    cvFileUrl: { type: String, default: '' },
    portfolio: [
      {
        title: String,
        url: String,
        description: String
      }
    ],
    viewCount: { type: Number, default: 0 }, // incremented each time an employer opens this candidate's applicant list
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
