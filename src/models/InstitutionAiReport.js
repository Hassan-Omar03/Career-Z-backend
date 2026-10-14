const mongoose = require('mongoose');

// A saved AI Operations report: the AI's text plus the exact records and totals it was built from,
// frozen at generation time so a past report can be reopened and checked even after the
// underlying fees, attendance or results change. Visible to the same people who can generate one.
const institutionAiReportSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    insights: { type: String, required: true },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    dataSummary: { type: String, default: '' }
  },
  { timestamps: true }
);

institutionAiReportSchema.index({ institution: 1, createdAt: -1 });

module.exports = mongoose.model('InstitutionAiReport', institutionAiReportSchema);
