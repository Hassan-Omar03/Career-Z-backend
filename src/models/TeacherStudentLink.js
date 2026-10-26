const mongoose = require('mongoose');

// A real, consent-gated relationship between an independent teacher and a student (spec:
// "Independent Teacher Enrollment" — private tuition/coaching). A teacher can never force-add a
// student: this record's status is the single source of truth for whether the teacher may
// actually manage that student's attendance/assignments/exams/results (enforced via the real
// Enrollment record this creates once active, not a separate parallel academic system).
const teacherStudentLinkSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    subject: { type: String, default: '' },
    status: {
      type: String,
      enum: ['invited', 'consent_pending', 'active', 'paused', 'completed', 'removed'],
      default: 'invited'
    },
    requiresGuardianApproval: { type: Boolean, default: false },
    invitedAt: { type: Date, default: Date.now },
    studentRespondedAt: { type: Date, default: null },
    guardianApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    guardianApprovedAt: { type: Date, default: null },
    feeAmount: { type: Number, default: null },
    feeCurrency: { type: String, default: 'PKR' },
    feePaidAt: { type: Date, default: null },
    // Who paid: the student or one of their approved guardians (shown to the family and teacher).
    feePaidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    feePaidByRole: { type: String, default: '' },
    feeReceipt: { type: String, default: '' },
    // Legacy: what Paddle was asked to charge, for tuition paid before JazzCash.
    paddleAmount: { type: Number, default: null },
    paddleCurrency: { type: String, default: '' },
    // Payments that arrived after the fee was already paid (e.g. student and parent both paid): the
    // teacher must refund these.
    extraPayments: [{ transactionId: String, payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, amount: Number, currency: String, at: Date }],
    // No `default: null` — an explicit null still counts as "present" for a sparse index and
    // collides across documents that never set it (same bug class fixed earlier on Fee.receiptNumber).
    paddleTransactionId: { type: String, unique: true, sparse: true }, // legacy Paddle payments only
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: '' },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

// One open/active relationship per teacher+student+course at a time.
teacherStudentLinkSchema.index(
  { teacher: 1, student: 1, course: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['invited', 'consent_pending', 'active', 'paused'] } } }
);

module.exports = mongoose.model('TeacherStudentLink', teacherStudentLinkSchema);
