const mongoose = require('mongoose');

// A course (optionally lesson-specific) discussion question. Visible to the course teacher,
// its enrolled students and the institution's moderators.
const forumThreadSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null, index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, default: '', trim: true, maxlength: 10000 },
  pinned: { type: Boolean, default: false },
  locked: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false }, // hidden by a moderator
  hiddenReason: { type: String, default: '' },
  acceptedReply: { type: mongoose.Schema.Types.ObjectId, ref: 'ForumReply', default: null },
  replyCount: { type: Number, default: 0 },
  lastActivityAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

module.exports = mongoose.model('ForumThread', forumThreadSchema);
