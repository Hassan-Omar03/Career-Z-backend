const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupConversation', required: true, index: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
    attachments: [{ name: String, url: String, type: String }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
