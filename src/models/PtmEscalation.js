const mongoose = require('mongoose');

// Spec: "Automatic escalation — agar parent baar baar PTM miss kare ya respond na kare to
// institution ko automatically flag ho." Triggered reactively (see ptm.controller.js
// checkAndEscalate) right when a meeting is marked no-show or cancelled by the parent — real
// events, not a guess — once the same parent+institution crosses the threshold in a rolling window.
const ptmEscalationSchema = new mongoose.Schema(
  {
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    reason: { type: String, required: true },
    meetings: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ParentTeacherMeeting' }],
    status: { type: String, enum: ['open', 'acknowledged'], default: 'open' },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acknowledgedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PtmEscalation', ptmEscalationSchema);
