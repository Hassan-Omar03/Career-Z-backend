const mongoose = require('mongoose');

// Spec Part "Student Dashboard - #16 Anonymous Questions": only a Student may post one, and
// only Teacher/Institution staff may answer — the `student` field is real (needed to notify
// the asker when answered) but is stripped out of every institution/teacher-facing response so
// the asker's identity never reaches them.
const anonymousQuestionSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subject: { type: String, default: '' },
    question: { type: String, required: true },
    answer: { type: String, default: '' },
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['pending', 'answered'], default: 'pending' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AnonymousQuestion', anonymousQuestionSchema);
