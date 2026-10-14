const mongoose = require('mongoose');

// Master spec 9.2 teacher types; a teacher may belong to several (e.g. lecturer and tuition teacher).
const TEACHER_CATEGORIES = ['school_teacher', 'college_lecturer', 'university_professor', 'madrasa_teacher', 'academy_teacher', 'tuition_teacher', 'online_instructor', 'corporate_trainer', 'vocational_trainer', 'language_teacher', 'freelance_teacher', 'guest_lecturer'];
const httpsUrl = { validator: (v) => !v || /^https:\/\/\S+$/i.test(v), message: 'Use a full https:// link.' };

const teacherProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    institutions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Institution' }],
    subjects: [{ type: String }],
    qualifications: [
      {
        title: String,
        institutionName: String,
        year: Number,
        documentUrl: String
      }
    ],
    experienceYears: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    independent: { type: Boolean, default: false }, // teaches without an institution
    categories: { type: [{ type: String, enum: TEACHER_CATEGORIES }], default: [] },
    // Public profile (spec 9.4 / Teacher Portfolio): cover image, a short intro video, how they teach.
    coverPhotoUrl: { type: String, default: '', validate: httpsUrl },
    introVideoUrl: { type: String, default: '', validate: httpsUrl },
    teachingStyle: { type: String, default: '', maxlength: 1500 },
    teachingModes: { type: [{ type: String, enum: ['online', 'in_person'] }], default: [] },
    // Opt-in: the public portfolio page (/teacher/:id) only exists when the teacher turns it on.
    publicPortfolio: { type: Boolean, default: false },
    // Lets a teacher opt out of the institution-facing "Find Teachers" directory (still
    // required for the current job-offer flow, since institutions have no other way to
    // discover a teacher's account to send an offer to). Default true so new teachers are
    // actually discoverable.
    visibleToInstitutions: { type: Boolean, default: true },

    status: { type: String, enum: ['active', 'suspended'], default: 'active' },

    // Stripe Connect Express account — lets an institution actually WIRE payroll to this
    // teacher's real bank account (not just mark a payslip "paid" on an internal ledger).
    // The teacher's bank details never touch our server — Stripe's own hosted onboarding
    // collects them directly.
    payout: {
      stripeAccountId: { type: String, default: null },
      payoutsEnabled: { type: Boolean, default: false },
      detailsSubmitted: { type: Boolean, default: false }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TeacherProfile', teacherProfileSchema);
module.exports.TEACHER_CATEGORIES = TEACHER_CATEGORIES;
