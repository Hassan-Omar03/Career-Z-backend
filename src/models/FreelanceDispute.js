const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'FreelanceOrder', required: true, index: true },
  milestone: { type: mongoose.Schema.Types.ObjectId, required: true },
  initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, required: true, trim: true, maxlength: 2000 },
  evidence: [{ name: { type: String, trim: true, maxlength: 120 }, url: { type: String, trim: true, maxlength: 600 } }],
  previousStatus: { type: String, default: 'funded' },
  status: { type: String, enum: ['open', 'resolved', 'refunded'], default: 'open', index: true },
  resolution: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, note: { type: String, default: '' } }
}, { timestamps: true });
schema.index({ milestone: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

module.exports = mongoose.model('FreelanceDispute', schema);
