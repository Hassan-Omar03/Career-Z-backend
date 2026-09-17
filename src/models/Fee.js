const mongoose = require('mongoose');

const feeSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    title: { type: String, required: true }, // e.g. "Tuition Fee - Term 1"
    // Structured fee type (spec 15D.7) — kept alongside the free-text title so institutions can
    // filter/report by type without losing their own custom titles.
    feeType: {
      type: String,
      enum: ['tuition', 'admission', 'exam', 'hostel', 'transport', 'library', 'activity', 'other'],
      default: 'other'
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'processing', 'paid', 'overdue', 'refunded'], default: 'pending' },
    paidAt: { type: Date, default: null },
    // Installments (spec 15D.7) — when set, this fee is one instalment of a larger plan; siblings
    // share planId so the frontend can group and show "Instalment 2 of 4".
    installment: {
      planId: { type: String, default: null },
      number: { type: Number, default: null },
      totalInstallments: { type: Number, default: null }
    },
    reminderSentAt: { type: Date, default: null }, // last automatic due-date reminder sent
    // Refund System (spec 15D.7)
    refund: {
      status: { type: String, enum: ['none', 'requested', 'approved', 'rejected', 'refunded'], default: 'none' },
      reason: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      requestedAt: { type: Date, default: null },
      processedAt: { type: Date, default: null },
      processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    // Digital Receipt System (spec 15D.8) — a unique, QR-verifiable receipt, same pattern as
    // Certificate.verifyCode, generated the moment a fee is marked paid.
    receiptNumber: { type: String, unique: true, sparse: true },
    // Real Stripe Checkout tracking (spec 4.6/3A.3) — set when a Checkout Session is created;
    // the fee moves to 'paid' only when the webhook confirms the session actually completed, not
    // when the session is merely created (that would be trusting the client, not the gateway).
    stripeSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },
    paddleTransactionId: { type: String, default: null },
    paidVia: { type: String, default: '' }, // e.g. "Bank Transfer", "Cash", "External Link" - real payment gateways are a later phase
    // Self-service payment fields — same honesty pattern as Donation: no real gateway, so the
    // payer (parent or student) self-confirms and gets a real, unique, server-generated receipt
    // reference. paidVia stays as free text for institution-recorded (cash/manual) payments.
    paymentMethod: { type: String, enum: ['bank_transfer', 'card', 'stripe', 'paddle', 'jazzcash', 'easypaisa', 'crypto', 'mobile_wallet', 'cash', 'other', ''], default: '' },
    transactionId: { type: String, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Full receipt breakdown (spec 3A.2) — grossAmount mirrors `amount` at payment time (kept
    // separate so a later refund/adjustment to `amount` never rewrites what was actually paid).
    // gatewayCharges/taxAmount stay 0 until a real gateway/tax engine is connected (see
    // utils/receiptCalc.js); platformCommission is real and Super-Admin-configurable (3A.1).
    grossAmount: { type: Number, default: null },
    platformCommission: { type: Number, default: 0 },
    gatewayCharges: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: null },
    // Escrow (spec 3A.3): a paid fee is 'held' until the institution releases it to their own
    // account. No real fund custody happens anywhere in this app (no payment gateway is
    // connected) — this is a real, auditable status machine, not a claim that CareerZ is
    // literally holding the institution's money in a bank account.
    escrowStatus: { type: String, enum: ['none', 'held', 'released'], default: 'none' },
    escrowReleasedAt: { type: Date, default: null },
    escrowReleasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Fee', feeSchema);
