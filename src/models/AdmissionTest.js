const mongoose = require('mongoose');

const admissionTestSchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true },
  program: { type: String, default: '', trim: true },
  subject: { type: String, default: '', trim: true },
  instructions: { type: String, default: '' },
  durationMinutes: { type: Number, required: true, min: 1, max: 240 },
  passingPercent: { type: Number, required: true, min: 0, max: 100, default: 50 },
  questions: [{
    text: { type: String, required: true, trim: true },
    type: { type: String, enum: ['mcq', 'true_false'], default: 'mcq' },
    options: [{ type: String, trim: true }],
    correctOption: { type: Number, required: true, min: 0 },
    marks: { type: Number, required: true, min: 1, default: 1 }
  }],
  published: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('AdmissionTest', admissionTestSchema);
