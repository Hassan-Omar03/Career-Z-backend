const mongoose = require('mongoose');

const interviewSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scheduledDate: { type: Date, required: true },
    // Master 12.10: first interview or final interview round.
    round: { type: String, enum: ['interview', 'final_interview'], default: 'interview' },
    mode: { type: String, enum: ['online', 'physical'], default: 'online' },
    location: { type: String, default: '' }, // physical address, when mode is 'physical'
    meetingLink: { type: String, default: '' }, // when mode is 'online'
    status: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' },
    feedback: { type: String, default: '' } // the interviewer's own notes, added after the interview
  },
  { timestamps: true }
);

module.exports = mongoose.model('Interview', interviewSchema);
