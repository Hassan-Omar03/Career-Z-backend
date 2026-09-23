const mongoose = require('mongoose');

const adminResourceSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  key: { type: String, default: '' },
  title: { type: String, required: true, trim: true },
  status: { type: String, default: 'active', index: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

adminResourceSchema.index({ type: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string', $gt: '' } } });
module.exports = mongoose.model('AdminResource', adminResourceSchema);
