const mongoose = require('mongoose');

// Group messaging (spec: "group conversations") — every participant must already be an approved
// communication contact of the creator at creation time (see groupConversation.controller.js), so
// a group can never be used to route around the same access rules 1:1 messaging enforces.
const groupConversationSchema = new mongoose.Schema(
  {
    institution:{type:mongoose.Schema.Types.ObjectId,ref:'Institution',default:null},
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('GroupConversation', groupConversationSchema);
