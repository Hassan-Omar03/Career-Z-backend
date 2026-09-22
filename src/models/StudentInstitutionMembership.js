const mongoose = require('mongoose');

// A student can now belong to more than one institution at once (spec: "multiple simultaneous
// institutions"), and this is the real transfer/history record StudentProfile.primaryInstitution
// alone couldn't provide — every institution a student has ever joined stays here even after
// they leave, instead of being silently overwritten.
const membershipSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    program: { type: String, default: '' },
    status: { type: String, enum: ['active', 'transferred', 'graduated', 'withdrawn'], default: 'active' },
    isPrimary: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date, default: null },
    reason: { type: String, default: '' }
  },
  { timestamps: true }
);

membershipSchema.index({ student: 1, institution: 1 }, { unique: true });

module.exports = mongoose.model('StudentInstitutionMembership', membershipSchema);
