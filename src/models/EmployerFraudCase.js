const mongoose = require('mongoose');

// Master 12.17: a fraud report against an employer (fake job, salary scam, fake interview,
// illegal recruitment, identity fraud). An admin reviews the evidence and acts on the ladder
// Warning → Temporary Suspension → Permanent Ban. Evidence is append-only and the case is kept
// as an archive; a report to the authorities is recorded only with evidence on file.
const evidenceSchema = new mongoose.Schema({ note: { type: String, required: true }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }, { _id: false });

const employerFraudCaseSchema = new mongoose.Schema(
  {
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    category: { type: String, enum: ['fake_job', 'salary_scam', 'fake_interview', 'illegal_recruitment', 'identity_fraud'], required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    description: { type: String, required: true },
    evidence: [evidenceSchema],
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open', index: true },
    action: { type: String, enum: ['', 'warning', 'suspension', 'ban'], default: '' },
    suspendedUntil: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    archivedAt: { type: Date, default: null },
    authorityReport: { authority: { type: String, default: '' }, note: { type: String, default: '' }, at: { type: Date, default: null }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null } }
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployerFraudCase', employerFraudCaseSchema);
