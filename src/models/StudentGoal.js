const mongoose = require('mongoose');

// Goal Tracking (spec Part 10.22) — the student sets their own goals (IELTS 8.0, finish a
// degree, win a scholarship, land a job) and self-reports progress. No AI involved here —
// that's a separate, later phase that needs the student's own AI API key.
const studentGoalSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: ['academic', 'scholarship', 'job', 'skill', 'other'], default: 'other' },
    targetDate: { type: Date, default: null },
    progressPercent: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active' },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentGoal', studentGoalSchema);
