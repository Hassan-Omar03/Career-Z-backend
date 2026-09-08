const mongoose = require('mongoose');

const resultSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    term: { type: String, default: '' }, // e.g. "Mid Term", "Final", "Semester 1"
    subject: { type: String, default: '' },
    marksObtained: { type: Number, required: true },
    totalMarks: { type: Number, required: true },
    grade: { type: String, default: '' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Result', resultSchema);
