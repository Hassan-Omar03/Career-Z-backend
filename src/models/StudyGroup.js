const mongoose = require('mongoose');

// Student Community (spec Part 10.20) — Study Groups. Any student can create one and invite
// others to join; membership gates who can read/post in it.
const studyGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    subject: { type: String, default: '' },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudyGroup', studyGroupSchema);
