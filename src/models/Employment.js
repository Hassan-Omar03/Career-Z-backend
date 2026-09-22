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
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['offered', 'accepted', 'declined', 'active', 'resigned', 'terminated'], default: 'offered' },
    offeredAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    startDate: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Employment', employmentSchema);
