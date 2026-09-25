const mongoose = require('mongoose');

// A single discussion message inside a Study Group (spec Part 10.20 "Discussion Rooms").
// Persisted (not ephemeral like live-class chat) since group discussions are durable history,
// and broadcast in real time over Socket.IO study-group rooms (see realtime/socket.js).
const studyGroupPostSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'StudyGroup', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', trim: true },
    attachments: [{ type: String }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudyGroupPost', studyGroupPostSchema);
