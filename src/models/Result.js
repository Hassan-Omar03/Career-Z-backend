const mongoose = require('mongoose');

const resultSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    academicSession: { type: String, default: '' },
    term: { type: String, default: '' }, // e.g. "Mid Term", "Final", "Semester 1"
    subject: { type: String, default: '' },
    marksObtained: { type: Number, required: true },
    totalMarks: { type: Number, required: true },
    grade: { type: String, default: '' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

resultSchema.index({ student: 1, exam: 1 }, { unique: true, partialFilterExpression: { exam: { $type: 'objectId' } } });

module.exports = mongoose.model('Result', resultSchema);
