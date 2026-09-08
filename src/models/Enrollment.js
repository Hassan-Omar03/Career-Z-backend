const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    status: { type: String, enum: ['active', 'completed', 'dropped'], default: 'active' },
    progressPercent: { type: Number, default: 0 },
    completedLessons: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }],
    enrolledAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
