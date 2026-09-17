const mongoose = require('mongoose');

// Internal platform team (spec Part 16A.14 / 16G.10-11 "Staff Management") — Super Admin gives
// each platform_staff member access to only specific departments. 'admin' and 'super_admin'
// always have full access regardless of this record; this only gates the narrower
// platform_staff role via the requireDepartment middleware.
const DEPARTMENTS = ['finance', 'support', 'verification', 'security', 'content', 'moderation'];

const staffProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    departments: [{ type: String, enum: DEPARTMENTS }],
    title: { type: String, default: '' }, // e.g. "Finance Manager" — display only
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

staffProfileSchema.statics.DEPARTMENTS = DEPARTMENTS;

module.exports = mongoose.model('StaffProfile', staffProfileSchema);
