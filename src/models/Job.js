const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['full_time', 'part_time', 'remote', 'hybrid', 'internship', 'freelance', 'government', 'ngo'],
      default: 'full_time'
    },
    country: { type: String, required: true },
    city: { type: String, default: '' },
    salaryMin: { type: Number, default: null },
    salaryMax: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    experienceYears: { type: Number, default: 0 },
    education: { type: String, default: '' },
    skills: [{ type: String }],
    description: { type: String, default: '' },
    applicationDeadline: { type: Date, default: null },
    visaSponsorship: { type: Boolean, default: false },
    companyLogo: { type: String, default: null },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    isGovernment: { type: Boolean, default: false }
  },
  { timestamps: true }
);

jobSchema.index({ title: 'text', company: 'text', skills: 'text' });

module.exports = mongoose.model('Job', jobSchema);
