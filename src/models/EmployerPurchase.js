const mongoose = require('mongoose');

// Master 12.18: what an employer bought (job promotion, subscription, hiring package, premium
// tools), granted once CareerZ approves the bank-transfer receipt. Kept as the invoice record.
const employerPurchaseSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    boughtBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    package: { type: String, enum: ['sponsored', 'urgent', 'top_hiring', 'subscription', 'hiring_package', 'premium_tools'], required: true },
    title: { type: String, required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    currency: { type: String, default: 'PKR' },
    baseAmount: { type: Number, required: true },
    taxPercent: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    days: { type: Number, default: 0 },
    credits: { type: Number, default: 0 },
    manualPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'ManualPayment', default: null },
    paymentRef: { type: String, default: '' },
    status: { type: String, enum: ['paid'], default: 'paid' },
    startsAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployerPurchase', employerPurchaseSchema);
