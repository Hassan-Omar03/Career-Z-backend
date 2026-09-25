const mongoose = require('mongoose');

// Achievement Timeline (spec Part 10.23) — persisted, verifiable records for the categories that
// have no other backing model in this codebase (awards, medals, competitions, projects,
// internships, research, volunteer work). Course/certificate/result/scholarship/job/goal entries
// stay computed on the fly from their own real models (see getMyAchievementTimeline) since those
// already are the durable record and persisting a copy would just risk drifting out of sync.
const achievementSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['award', 'medal', 'competition', 'project', 'internship', 'research', 'volunteer', 'other'],
      required: true
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    evidenceUrl: { type: String, default: '' },
    visibility: { type: String, enum: ['public', 'private'], default: 'private' },

    // Self-added by the student; only counts toward the verified timeline / badge rules once an
    // institution staff member or the course teacher confirms it against real evidence.
    verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    verifierNotes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Achievement', achievementSchema);
