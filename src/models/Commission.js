const mongoose = require('mongoose');

// Earned automatically when a candidate an education_agent placed (via their own job
// posting) is marked "hired" — a real, computed ledger entry, not a manual/fabricated one.
const commissionSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Who pays it: the employer the agent recruited for (agent's own job), or the institute (agreement).
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    // One of these two: a registered candidate's application or a guest's (see GuestApplication).
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication' },
    guestApplication: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestApplication' },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null for a guest applicant
    candidateName: { type: String, default: '' },
    rate: { type: Number, default: 10 }, // percentage of salaryMin used to compute amount
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'PKR' },
    // pending: just earned, awaiting review -> approved: reviewed, confirmed legitimate
    // -> available: cleared for withdrawal -> paid: included in a completed withdrawal.
    // cancelled: the underlying hire fell through (application status moved off "hired").
    status: { type: String, enum: ['pending', 'approved', 'available', 'paid', 'cancelled'], default: 'pending' },
    // 'agent_job': existing agent placement commission. 'recruitment_agreement': a fee an institute
    // owes under an accepted agreement; `amount` is the agent's earning and the rest is broken out.
    source: { type: String, enum: ['agent_job', 'recruitment_agreement'], default: 'agent_job' },
    agreement: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentAgreement', default: null },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentInvoice', default: null },
    grossFee: { type: Number, default: null },
    platformFee: { type: Number, default: null },
    processingCharges: { type: Number, default: null },
    calculation: { type: String, default: '' },
    // The open withdrawal this commission is reserved by; null when it can be withdrawn.
    withdrawal: { type: mongoose.Schema.Types.ObjectId, ref: 'Withdrawal', default: null }
  },
  { timestamps: true }
);
commissionSchema.index({ application: 1 }, { unique: true, partialFilterExpression: { application: { $type: 'objectId' } } });
commissionSchema.index({ guestApplication: 1 }, { unique: true, partialFilterExpression: { guestApplication: { $type: 'objectId' } } });

module.exports = mongoose.model('Commission', commissionSchema);
