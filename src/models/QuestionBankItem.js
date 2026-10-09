const mongoose = require('mongoose');

// A reusable exam/quiz question. Institution questions are shared with every teacher of that
// institution; an independent teacher's questions (institution null) are private to them.
const questionBankItemSchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: String, trim: true, default: '', index: true },
  topic: { type: String, trim: true, default: '' },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  tags: [{ type: String, trim: true }],
  text: { type: String, required: true, trim: true },
  type: { type: String, enum: ['mcq', 'short', 'long'], default: 'mcq' },
  options: [{ type: String }],
  correctOption: { type: Number, default: null },
  marks: { type: Number, default: 1, min: 0.5 },
  timesUsed: { type: Number, default: 0 },
  archived: { type: Boolean, default: false }
}, { timestamps: true });

questionBankItemSchema.index({ text: 'text', topic: 'text', tags: 'text' });

module.exports = mongoose.model('QuestionBankItem', questionBankItemSchema);
