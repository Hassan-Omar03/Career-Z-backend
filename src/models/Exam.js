const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    type: { type: String, enum: ['mcq', 'short'], default: 'mcq' },
    options: [{ type: String }], // only used for type: 'mcq'
    correctOption: { type: Number, default: null }, // index into options, only for type: 'mcq'
    marks: { type: Number, default: 1 }
  },
  { _id: false }
);

const examSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    type: { type: String, enum: ['quiz', 'midterm', 'final', 'test'], default: 'quiz' },
    durationMinutes: { type: Number, default: 0 }, // 0 = untimed
    scheduledDate: { type: Date, default: null },
    questions: [questionSchema],
    published: { type: Boolean, default: false }
  },
  { timestamps: true }
);

examSchema.virtual('totalMarks').get(function () {
  return this.questions.reduce((sum, q) => sum + (q.marks || 0), 0);
});
examSchema.set('toJSON', { virtuals: true });
examSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Exam', examSchema);
