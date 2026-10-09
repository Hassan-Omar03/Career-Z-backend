const mongoose = require('mongoose');

// Audit trail of every verification status change (who, from → to, why).
const verificationHistorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, required: true },
  request: { type: mongoose.Schema.Types.ObjectId, ref: 'RoleRequest', default: null },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = the user/system
  previousStatus: { type: String, default: '' },
  newStatus: { type: String, required: true },
  remarks: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('VerificationHistory', verificationHistorySchema);
