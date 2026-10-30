const mongoose = require('mongoose');

// Teaching and non-teaching staff categories (institutes hire drivers, wardens, accountants...).
const JOB_CATEGORIES = ['teaching', 'academic_leadership', 'administration', 'finance_accounts', 'it_technical', 'transport', 'hostel', 'security', 'library', 'lab', 'maintenance_cleaning', 'healthcare', 'sales_marketing', 'engineering', 'customer_service', 'other'];

const jobSchema = new mongoose.Schema(
  {
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Set when a verified institute posts its own vacancy (Master 4.24, 5.5). The institute's
    // owner and staff with 'recruitment:manage' manage it alongside the person who posted it.
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
    category: { type: String, enum: JOB_CATEGORIES, default: 'other' },
    // Set when an agent publishes under an active Institute–Agent agreement.
    recruitmentRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentRequest', default: null },
    agreement: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentAgreement', default: null, index: true },
    // An agent's own job is posted for an employer on CareerZ, who must accept; that employer pays
    // the agent's commission on a successful hire (master: commission between agents and employers).
    representedEmployer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    employerConsent: {
      status: { type: String, enum: ['', 'pending', 'accepted', 'declined'], default: '' },
      ratePercent: { type: Number, default: null }, // commission % of the salary the employer agreed to
      at: { type: Date, default: null },
      note: { type: String, default: '' }
    },
    title: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['full_time', 'part_time', 'internship', 'freelance', 'government', 'ngo'],
      default: 'full_time'
    },
    // Separate from `type` (employment type) — "Onsite/Remote/Hybrid" is its own field per the
    // job-seeker dashboard spec, since a job can be e.g. full_time AND remote at once.
    workMode: { type: String, enum: ['onsite', 'remote', 'hybrid'], default: 'onsite' },
    country: { type: String, required: true },
    city: { type: String, default: '' },
    salaryMin: { type: Number, default: null },
    salaryMax: { type: Number, default: null },
    currency: { type: String, default: 'PKR' },
    experienceYears: { type: Number, default: 0 },
    education: { type: String, default: '' },
    skills: [{ type: String }],
    description: { type: String, default: '' },
    applicationDeadline: { type: Date, default: null },
    vacancies: { type: Number, default: 1, min: 1, max: 1000 },
    views: { type: Number, default: 0 },
    sponsored: { type: Boolean, default: false },
    sponsoredUntil: { type: Date, default: null },
    urgent: { type: Boolean, default: false },
    urgentUntil: { type: Date, default: null },
    genderPreference: { type: String, enum: ['any', 'male', 'female'], default: 'any' },
    ageMin: { type: Number, default: null, min: 14, max: 80 },
    ageMax: { type: Number, default: null, min: 14, max: 80 },
    // Private to the hiring side: never sent with public job listings.
    interviewQuestions: { type: [String], select: false },
    visaSponsorship: { type: Boolean, default: false },
    companyLogo: { type: String, default: null },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    // pending_review: held by the risk scan for an admin (Master 12.5); rejected: admin declined.
    status: { type: String, enum: ['draft', 'pending_review', 'active', 'paused', 'closed', 'filled', 'rejected', 'removed_by_admin'], default: 'active' },
    // Removed by a CareerZ admin (fake or suspicious): hidden everywhere; the owner sees the reason.
    adminRemoval: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, reason: { type: String, default: '' }, previousStatus: { type: String, default: '' } },
    moderation: {
      riskScore: { type: Number, default: 0 },
      flags: [{ code: String, label: String, points: Number, _id: false }],
      submittedAt: { type: Date, default: null },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reviewedAt: { type: Date, default: null },
      note: { type: String, default: '' }
    },
    publishedAt: { type: Date, default: null },
    isGovernment: { type: Boolean, default: false },
    // Revenue: Part 4.26 "Featured Jobs" — employer/agent pays to have a listing shown first
    // with a badge. featuredUntil is cleared (not just left stale) once it lapses, in listJobs.
    featured: { type: Boolean, default: false },
    featuredUntil: { type: Date, default: null }
  },
  { timestamps: true }
);

jobSchema.index({ title: 'text', company: 'text', skills: 'text' });

module.exports = mongoose.model('Job', jobSchema);
module.exports.JOB_CATEGORIES = JOB_CATEGORIES;
