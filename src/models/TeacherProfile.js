const mongoose = require('mongoose');

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
