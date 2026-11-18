const mongoose = require('mongoose');

// Who changed an institute staff member's access, and how (master 5.6 staff permission system). Shown
// to the owner under Staff Management as "Recent staff changes".
const staffChangeLogSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['added', 'role_changed', 'permissions_changed', 'suspended', 'reinstated', 'removed'], required: true },
    fromRole: { type: String, default: '' },
    toRole: { type: String, default: '' },
    note: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);
staffChangeLogSchema.index({ institution: 1, createdAt: -1 });

module.exports = mongoose.model('StaffChangeLog', staffChangeLogSchema);
