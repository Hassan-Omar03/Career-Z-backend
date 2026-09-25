const mongoose = require('mongoose');

// Reputation / Badges (spec Part 10.19) — persisted award record with a real earnedAt date, so a
// badge shown on a profile/portfolio has a permanent timestamp instead of being recomputed (and
// silently re-dated) on every request. getMyBadges still evaluates the same rules live and
// upserts a Badge doc the first time a rule becomes true; already-earned rows are never removed
// even if the underlying data later changes (a badge earned is a badge kept).
const badgeSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    code: { type: String, required: true },
    label: { type: String, required: true },
    desc: { type: String, default: '' },
    earnedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

badgeSchema.index({ student: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Badge', badgeSchema);
