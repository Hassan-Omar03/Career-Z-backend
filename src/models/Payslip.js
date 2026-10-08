const mongoose = require('mongoose');

const payslipSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    basicSalary: { type: Number, required: true, min: 0 },
    bonuses: { type: Number, default: 0 },
    overtimeAmount: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['pending', 'processing', 'paid', 'rejected'], default: 'pending' },
    paidAt: { type: Date },
    paymentMethod: { type: String, enum: ['bank_transfer', 'mobile_wallet', 'crypto', 'cash', 'other', 'platform_wallet', 'stripe_transfer', ''], default: '' },
    transactionId: { type: String, default: null },
    paymentReference: { type: String, default: '' },
    paymentProofUrl: { type: String, default: '' },
    paymentProvider: { type: String, default: '' },
    paymentReportedAt: { type: Date, default: null },
    paymentVerifiedAt: { type: Date, default: null },
    paymentVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paymentRejectedAt: { type: Date, default: null },
    paymentRejectionReason: { type: String, default: '' },
    // Legacy: Stripe Connect transfer state from before Stripe was removed ('stripe_transfer' payslips).
    stripeTransferId: { type: String, default: null },
    stripeTransferStatus: { type: String, enum: ['none', 'sent', 'failed'], default: 'none' },
    stripeTransferError: { type: String, default: '' },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

payslipSchema.index({ institution: 1, staff: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Payslip', payslipSchema);
