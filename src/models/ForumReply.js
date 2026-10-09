const mongoose = require('mongoose');

const forumReplySchema = new mongoose.Schema({
  thread: { type: mongoose.Schema.Types.ObjectId, ref: 'ForumThread', required: true, index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true, trim: true, maxlength: 10000 },
  byTeacher: { type: Boolean, default: false }, // written by the course teacher or a moderator
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  hidden: { type: Boolean, default: false },
  hiddenReason: { type: String, default: '' },
  editedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('ForumReply', forumReplySchema);
