const mongoose = require('mongoose');

// One student in one batch (master: every enrollment has its own institution, course, class,
// schedule, progress, payment and status). It never touches the student's primary school record.
const batchEnrollmentSchema = new mongoose.Schema(
  {
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    status: { type: String, enum: ['pending', 'waitlisted', 'active', 'completed', 'left', 'rejected', 'transferred'], default: 'pending', index: true },
    note: { type: String, default: '' },
    requestedAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    transferredTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null },
    // The last billing period a fee was created for (YYYY-MM, or 'one-time').
    billedThrough: { type: String, default: '' }
  },
  { timestamps: true }
);
batchEnrollmentSchema.index({ batch: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('BatchEnrollment', batchEnrollmentSchema);
