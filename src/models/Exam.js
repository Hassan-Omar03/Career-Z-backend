const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    type: { type: String, enum: ['mcq', 'short', 'long'], default: 'mcq' },
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
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    subject: { type: String, default: '' },
    academicSession: { type: String, default: '' },
    term: { type: String, default: '' },
    title: { type: String, required: true },
    type: { type: String, enum: ['quiz', 'midterm', 'final', 'test'], default: 'quiz' },
    durationMinutes: { type: Number, default: 0 }, // 0 = untimed
    scheduledDate: { type: Date, default: null },
    closesAt: { type: Date, default: null },
    passingPercent: { type: Number, default: 50, min: 0, max: 100 },
    venue: { type: String, default: '' }, // physical exam center, or an online link
    instructions: { type: String, default: '' }, // preparation notes shown to students/parents
    questions: [questionSchema],
    // Exam security / anti-cheating controls (applied per attempt by startExam).
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    questionsPerAttempt: { type: Number, default: 0, min: 0 }, // 0 = every question; N = random N per student
    flagThreshold: { type: Number, default: 3, min: 1 }, // integrity events before an attempt is flagged
    published: { type: Boolean, default: false }
  },
  { timestamps: true }
);

examSchema.virtual('totalMarks').get(function () {
  // Some lightweight result queries intentionally exclude the full question paper. In that
  // case Mongoose still serializes virtuals, so the getter must tolerate an unselected field.
  return (this.questions || []).reduce((sum, q) => sum + (q.marks || 0), 0);
});
examSchema.set('toJSON', { virtuals: true });
examSchema.set('toObject', { virtuals: true });

examSchema.post('save',async function(){await require('../services/learningBackup.service').capture(this.course,this.$session()||null);});
examSchema.pre('deleteOne',{document:true,query:false},async function(){await require('../services/learningBackup.service').capture(this.course,this.$session()||null);});
examSchema.pre('findOneAndDelete',async function(){const item=await this.model.findOne(this.getFilter()).lean();if(item)await require('../services/learningBackup.service').capture(item.course,this.getOptions().session||null);});
module.exports = mongoose.model('Exam', examSchema);
