const mongoose = require('mongoose');

// The real "after you're hired" record a JobApplication.status='hired' label alone never gave —
// a formal offer the candidate must actually accept, a start date, salary, and a resignation/
// termination history (spec: Student/Teacher<->Employer "offer acceptance/rejection, employment
// contract, employee onboarding/linking, salary/employment record").
const employmentSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', required: true, unique: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    salary: { type: Number, default: null },
    currency: { type: String, default: 'PKR' },
    status: { type: String, enum: ['offered', 'accepted', 'declined', 'withdrawn', 'active', 'completed', 'resigned', 'terminated'], default: 'offered' },
    offeredAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    startDate: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: '' },
    // Offer made from the Offer stage (services/jobOffer.service.js) and the letter sent after acceptance.
    offer: {
      salaryPeriod: { type: String, enum: ['month', 'year', 'hour'], default: 'month' },
      expiresAt: { type: Date, default: null }, terms: { type: String, default: '' },
      sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, sentAt: { type: Date, default: null },
      // Agent jobs: the institute's offer goes to the agent, who forwards it to the candidate.
      viaAgent: { type: Boolean, default: false }, forwardedAt: { type: Date, default: null }
    },
    // Typed full name, time and device the candidate signed with when accepting the offer.
    signature: { name: { type: String, default: '' }, at: { type: Date, default: null }, ip: { type: String, default: '' }, userAgent: { type: String, default: '' } },
    offerLetter: {
      text: { type: String, default: '' }, file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', default: null },
      issuer: { type: String, default: '' }, sentAt: { type: Date, default: null }, sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      forwardedAt: { type: Date, default: null }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Employment', employmentSchema);
