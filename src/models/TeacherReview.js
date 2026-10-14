const mongoose = require('mongoose');

// Institution's performance review of one of its teachers for a period (master spec 8.9). Starts
// as a draft; once shared the teacher can read it and add their own response.
const AREAS = ['teaching', 'studentResults', 'punctuality', 'communication', 'professionalism'];
const score = { type: Number, min: 1, max: 5, required: true };

const teacherReviewSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true, trim: true, maxlength: 80 }, // e.g. "2026 Term 1"
    ratings: Object.fromEntries(AREAS.map((a) => [a, score])),
    overall: { type: Number, default: null },
    strengths: { type: String, default: '', maxlength: 2000 },
    improvements: { type: String, default: '', maxlength: 2000 },
    goals: { type: String, default: '', maxlength: 2000 },
    // The record the reviewer looked at, frozen when the review was shared.
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: ['draft', 'shared'], default: 'draft' },
    sharedAt: { type: Date, default: null },
    teacherResponse: { type: String, default: '', maxlength: 2000 },
    acknowledgedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

teacherReviewSchema.index({ institution: 1, teacher: 1, period: 1 }, { unique: true });
teacherReviewSchema.pre('validate', function () {
  const values = AREAS.map((a) => this.ratings?.[a]).filter((v) => typeof v === 'number');
  this.overall = values.length === AREAS.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
});

module.exports = mongoose.model('TeacherReview', teacherReviewSchema);
module.exports.AREAS = AREAS;
