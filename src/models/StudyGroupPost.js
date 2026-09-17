const mongoose = require('mongoose');

// A single discussion message inside a Study Group (spec Part 10.20 "Discussion Rooms").
const studyGroupPostSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'StudyGroup', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudyGroupPost', studyGroupPostSchema);
