const mongoose = require('mongoose');

// A real, relationship-verified rating of a teacher — the controller only accepts one from a
// student actually enrolled under that teacher, a parent whose linked child is, or an
// institution the teacher is actually staff at (see teacherFeedback.controller.js). One rating
// per rater per teacher per institution context, so a student/parent/institution can update
// their own rating but not stuff the average with repeats.
const teacherFeedbackSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromRole: { type: String, enum: ['student', 'parent', 'institution'], required: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' }
  },
  { timestamps: true }
);

teacherFeedbackSchema.index({ teacher: 1, fromUser: 1, institution: 1 }, { unique: true });

module.exports = mongoose.model('TeacherFeedback', teacherFeedbackSchema);
