const mongoose = require('mongoose');

// A one-directional block — the blocker never sees/receives messages from the blocked user again,
// regardless of any shared institution/course/parent link that would otherwise allow contact.
const blockedUserSchema = new mongoose.Schema(
  {
    blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }
  },
  { timestamps: true }
);

blockedUserSchema.index({ blocker: 1, blocked: 1 }, { unique: true });

module.exports = mongoose.model('BlockedUser', blockedUserSchema);
