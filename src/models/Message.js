const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true },
    attachments: [{ name: String, url: String, type: String }],
    // Delivered = the recipient had an active connection at send time (proxy for "reached a live
    // device"). Read is a separate, stronger signal — the recipient actually opened the thread.
    deliveredAt: { type: Date, default: null },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Fast lookup of a conversation between two specific users, in either direction.
messageSchema.index({ from: 1, to: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
