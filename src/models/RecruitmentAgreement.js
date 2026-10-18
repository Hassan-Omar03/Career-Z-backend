const mongoose = require('mongoose');

// The terms an institute and an agent both accept before the agent recruits for the institute.
// Every change creates a new version; only a version accepted by both sides is active, and only an
// active agreement authorizes job publication on the institute's behalf. No rate or rule is
// filled in by the platform: every amount, trigger and replacement term comes from the parties.

const recruitmentAgreementSchema = new mongoose.Schema(
  {
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentRequest', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    proposedSide: { type: String, enum: ['institution', 'agent'], required: true },

    // Authorized vacancies (copied from the request positions the parties agree on).
    positions: [{ title: String, category: String, vacancies: Number, _id: false }],
    vacancyCount: { type: Number, required: true, min: 1 },

    feeModel: { type: String, enum: ['fixed_per_hire', 'percentage', 'package'], required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    fixedAmount: { type: Number, default: null, min: 0 },          // per successful hire
    percentage: { type: Number, default: null, min: 0, max: 100 },  // of salaryBase
    salaryBase: { type: String, enum: ['', 'monthly_salary', 'annual_salary'], default: '' },
    packageAmount: { type: Number, default: null, min: 0 },
    packageHires: { type: Number, default: null, min: 1 },          // hires the package covers

    paymentTrigger: { type: String, enum: ['joining_confirmed'], default: 'joining_confirmed' },
    paymentDueDays: { type: Number, required: true, min: 0, max: 365 },

    // Replacement / refund terms are optional and entirely the parties' own.
    replacement: {
      periodDays: { type: Number, default: null, min: 1, max: 365 },
      deadlineDays: { type: Number, default: null, min: 1, max: 365 },
      attempts: { type: Number, default: null, min: 1, max: 10 },
      exceptions: { type: String, default: '', maxlength: 1500 },
      refundTerms: { type: String, default: '', maxlength: 1500 }
    },
    notes: { type: String, default: '', maxlength: 2000 },

    status: { type: String, enum: ['proposed', 'active', 'superseded', 'declined', 'ended'], default: 'proposed', index: true },
    institutionAcceptance: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null } },
    agentAcceptance: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null } },
    endedAt: { type: Date, default: null }
  },
  { timestamps: true }
);
recruitmentAgreementSchema.index({ request: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('RecruitmentAgreement', recruitmentAgreementSchema);
