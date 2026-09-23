const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  action: { type: String, required: true, index: true },
  method: { type: String, required: true },
  path: { type: String, required: true },
  targetType: { type: String, default: '' },
  targetId: { type: String, default: '' },
  statusCode: { type: Number, required: true },
  ip: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

adminAuditLogSchema.index({ createdAt: -1 });
module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
