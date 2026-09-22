const mongoose = require('mongoose');

const coursePurchaseSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['stripe', 'paddle'], required: true },
  providerCheckoutId: { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date, default: null },
  providerPaymentId: { type: String, default: null }
}, { timestamps: true });

coursePurchaseSchema.index({ provider: 1, providerCheckoutId: 1 }, { unique: true });
module.exports = mongoose.model('CoursePurchase', coursePurchaseSchema);
