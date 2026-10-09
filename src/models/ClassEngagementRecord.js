const mongoose = require('mongoose');

// A durable summary of one live-class session's Class Energy Meter + poll activity, written when
// the session ends (see realtime/socket.js class:end) — the live in-memory session itself is
// still ephemeral by design (restart-safe teaching state), but its engagement OUTCOME is now kept
// for history/reporting, closing the "no historical engagement analytics" gap.
const classEngagementRecordSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    liveClassSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveClassSession', default: null, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    participantCount: { type: Number, default: 0 },
    averageEnergy: { type: Number, default: null }, // 0-100, null if energy tracking was never used
    attentiveCount: { type: Number, default: 0 },
    roster: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: String,
        attentive: Boolean,
        score: Number
      }
    ],
    poll: {
      question: { type: String, default: '' },
      options: [{ text: String, votes: Number }]
    }
  },
  { timestamps: true }
);

classEngagementRecordSchema.index({ course: 1, createdAt: -1 });

module.exports = mongoose.model('ClassEngagementRecord', classEngagementRecordSchema);
