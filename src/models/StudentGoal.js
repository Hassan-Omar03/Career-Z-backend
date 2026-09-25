const mongoose = require('mongoose');

// Goal Tracking (spec Part 10.22) — the student sets their own goals (IELTS 8.0, finish a
// degree, win a scholarship, land a job) and tracks progress via milestones. Completing an
// academic/scholarship/job goal requires evidence + a teacher/institution sign-off before it
// counts as a verified lifetime achievement — a 'skill'/'other' goal completes on self-report,
// since not every personal goal has a real-world record behind it.
const studentGoalSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: ['academic', 'scholarship', 'job', 'skill', 'other'], default: 'other' },
    targetDate: { type: Date, default: null },
    progressPercent: { type: Number, default: 0, min: 0, max: 100 },
    milestones: [
      {
        title: { type: String, required: true },
        done: { type: Boolean, default: false }
      }
    ],
    status: { type: String, enum: ['active', 'pending_verification', 'completed', 'abandoned'], default: 'active' },
    notes: { type: String, default: '' },

    requiresVerification: { type: Boolean, default: false },
    evidenceUrl: { type: String, default: '' },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    verifierNotes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentGoal', studentGoalSchema);
