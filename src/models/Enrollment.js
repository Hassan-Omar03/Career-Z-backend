const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    status: { type: String, enum: ['active', 'completed', 'dropped'], default: 'active' },
    // Lesson/content progress only — "how much of the material has this student gone through."
    // Deliberately NOT the same thing as course completion (see overallScore/completionStatus):
    // a 1-lesson course would otherwise hit 100% the instant that one lesson is marked done.
    progressPercent: { type: Number, default: 0 },
    completedLessons: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }],
    // Weighted composite of lessons + graded assignments + graded tests + attendance, per the
    // course's own completionRules.weights — this is "real" course completion, not just content
    // consumption. Recomputed by utils/courseProgress.js on every contributing event.
    overallScore: { type: Number, default: 0 },
    completionStatus: { type: String, enum: ['in_progress', 'pending_approval', 'completed'], default: 'in_progress' },
    enrolledAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
