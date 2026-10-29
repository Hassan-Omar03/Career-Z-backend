const mongoose = require('mongoose');

// Master 12.10 company staff: people an employer adds to run hiring on the company's behalf
// (HR, Finance, Manager, Recruiter, Supervisor), each with their own permissions. The member is
// any CareerZ account (an individual too); they accept the invitation before it takes effect.
const employerStaffSchema = new mongoose.Schema(
  {
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['hr', 'finance', 'manager', 'recruiter', 'supervisor'], required: true },
    permissions: [{ type: String }],
    status: { type: String, enum: ['invited', 'active', 'declined', 'removed'], default: 'invited', index: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    respondedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null }
  },
  { timestamps: true }
);
employerStaffSchema.index({ employer: 1, member: 1 }, { unique: true });

module.exports = mongoose.model('EmployerStaff', employerStaffSchema);
