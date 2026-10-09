const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number, required: true },
    selectedOption: { type: Number, default: null }, // for mcq
    textAnswer: { type: String, default: '' }, // for short
    marksAwarded: { type: Number, default: 0 }
  },
  { _id: false }
);

const examSubmissionSchema = new mongoose.Schema(
  {
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    answers: [answerSchema],
    score: { type: Number, default: 0 },
    finalGrade: { type: String, default: '' },
    status: { type: String, enum: ['in_progress', 'submitted', 'graded'], default: 'in_progress' },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    submittedAt: { type: Date, default: Date.now },
    gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    gradedAt: { type: Date, default: null },
    // This attempt's paper: original question indexes in display order, and for each displayed
    // MCQ the original option indexes in display order. Empty = legacy identity order.
    questionOrder: { type: [Number], default: [] },
    optionOrders: { type: [[Number]], default: [] },
    // Integrity log: tab switches, copy/paste, fullscreen exits, IP/device changes.
    securityEvents: [{ type: { type: String }, at: { type: Date, default: Date.now }, detail: { type: String, default: '' }, _id: false }],
    flagged: { type: Boolean, default: false },
    startIp: { type: String, default: '' },
    startUserAgent: { type: String, default: '' }
  },
  { timestamps: true }
);

examSubmissionSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ExamSubmission', examSubmissionSchema);
