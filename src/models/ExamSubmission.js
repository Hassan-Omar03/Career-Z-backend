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
    status: { type: String, enum: ['submitted', 'graded'], default: 'submitted' },
    submittedAt: { type: Date, default: Date.now },
    gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    gradedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

examSubmissionSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ExamSubmission', examSubmissionSchema);
