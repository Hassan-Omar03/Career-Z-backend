const mongoose = require('mongoose');

// Any verified user can offer services (master Phase A4, Freelancer Hub).
const TYPES = ['Freelancer', 'Consultant', 'Trainer', 'Mentor', 'Coach', 'Designer', 'Developer', 'Writer', 'Translator'];

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  type: { type: String, enum: TYPES, default: 'Freelancer' },
  headline: { type: String, trim: true, maxlength: 120, default: '' },
  about: { type: String, trim: true, maxlength: 3000, default: '' },
  skills: [{ type: String, trim: true, maxlength: 40 }],
  portfolio: [{ title: { type: String, trim: true, maxlength: 120 }, url: { type: String, trim: true, maxlength: 500 }, image: { type: String, trim: true, maxlength: 600 } }]
}, { timestamps: true });

module.exports = mongoose.model('FreelanceProfile', schema);
module.exports.TYPES = TYPES;
