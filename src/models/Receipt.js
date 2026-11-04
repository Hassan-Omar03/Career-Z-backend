const mongoose = require('mongoose');

// The permanent record of one completed payment. Issued once and never changed.
const receiptSchema = new mongoose.Schema({
  receiptNumber: { type: String, required: true, unique: true },
  transactionType: { type: String, required: true },
  transaction: { type: mongoose.Schema.Types.ObjectId, required: true },
  reference: { type: String, default: '' },
  title: { type: String, default: '' },
  payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  payerName: { type: String, default: '' },
  recipientName: { type: String, default: 'CareerZ' },
  paymentMethod: { type: String, default: '' },
  grossAmount: { type: Number, required: true },
  currency: { type: String, required: true },
  gatewayFee: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  platformCommission: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  issuedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

receiptSchema.index({ transactionType: 1, transaction: 1 }, { unique: true });
const locked = function refuse(next) { next(new Error('A receipt cannot be changed after it is issued.')); };
receiptSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], locked);
receiptSchema.pre('save', function onlyNew(next) { if (this.isNew) next(); else locked(next); });

module.exports = mongoose.model('Receipt', receiptSchema);
