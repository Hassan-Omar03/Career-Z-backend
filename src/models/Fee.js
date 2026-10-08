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
    // 'scheduled'/'partially_paid'/'waived'/'cancelled' are new (spec 15D.7 lifecycle); every
    // pre-existing Fee document keeps working with its original status untouched.
    status: { type: String, enum: ['scheduled', 'pending', 'processing', 'partially_paid', 'paid', 'overdue', 'waived', 'cancelled', 'refunded'], default: 'pending' },
    paidAt: { type: Date, default: null },

    // Professional fee-plan generation (spec 15D.7) — set only on invoices generated via
    // FeeSchedule; a legacy/manually-created Fee simply leaves these at their defaults (backward
    // compatible — see utils/feeSchedule.js and migration notes).
    schedule: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeSchedule', default: null },
    academicYear: { type: String, default: '' },
    term: { type: String, default: '' },
    billingPeriod: { type: String, default: '' }, // e.g. '2026-03', '2026-Term1', '2026' — one Fee per (schedule, billingPeriod, installmentNumber)

    // Discounts/concessions/scholarships (spec) — `amount` above is always the FINAL payable
    // figure; `originalAmount` preserves what it was before any adjustment, so both can be shown.
    originalAmount: { type: Number, default: null },
    components: [{ type: { type: String, enum: ['tuition', 'transport', 'hostel', 'mess', 'security', 'other'], default: 'other' }, label: String, amount: Number, billingPeriod: String, reason: String }],
    discounts: [
      {
        kind: { type: String, enum: ['percentage', 'fixed', 'sibling', 'merit_scholarship', 'need_based_scholarship', 'staff_child', 'waiver', 'custom'], required: true },
        reason: { type: String, default: '' },
        percent: { type: Number, default: null },
        amount: { type: Number, required: true }, // the actual currency amount this adjustment removed
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        approvedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, default: null }
      }
    ],

    // Partial payments (spec) — `amount` is the current payable total after discounts; paidAmount
    // accumulates every verified payment; outstandingAmount is always amount - paidAmount, kept in
    // sync by utils/feeSchedule.js's applyPaymentToFee (never let outstanding go negative).
    paidAmount: { type: Number, default: 0 },
    outstandingAmount: { type: Number, default: null },
    paymentHistory: [
      {
        amount: { type: Number, required: true },
        method: { type: String, default: '' },
        transactionId: { type: String, default: null },
        reference: { type: String, default: '' },
        proofUrl: { type: String, default: '' },
        bankName: { type: String, default: '' },
        paidOn: { type: Date, default: null },
        notes: { type: String, default: '' },
        verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'verified' },
        previousFeeStatus: { type: String, default: '' },
        paidAt: { type: Date, default: Date.now },
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedAt: { type: Date, default: null },
        rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        rejectedAt: { type: Date, default: null },
        rejectionReason: { type: String, default: '' },
        receiptNumber: { type: String, default: null },
        verifyCode: { type: String, default: null }
      }
    ],

    graceEndDate: { type: Date, default: null },
    lateFeeAmount: { type: Number, default: 0 },
    lateFeeAppliedAt: { type: Date, default: null }, // set once — the real guard against double-charging

    // Restriction lifecycle (spec) — whether THIS fee is currently the reason access is blocked at
    // this institution, and the notification-dedupe log so a reminder never fires twice per stage.
    restrictionActive: { type: Boolean, default: false },
    notificationLog: [{ stage: { type: String, required: true }, sentAt: { type: Date, default: Date.now } }],

    paymentArrangement: {
      revisedDueDate: { type: Date, default: null },
      installments: [{ amount: Number, dueDate: Date }],
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reason: { type: String, default: '' },
      status: { type: String, enum: ['none', 'active', 'completed', 'defaulted'], default: 'none' }
    },

    // Digital receipt QR verification (spec 15D.8) — same pattern as Certificate.verifyCode.
    verifyCode: { type: String, default: null, index: true },
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
    cancellation: {
      reason: { type: String, default: '' },
      cancelledAt: { type: Date, default: null },
      cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    // Digital Receipt System (spec 15D.8) — a unique, QR-verifiable receipt, same pattern as
    // Certificate.verifyCode, generated the moment a fee is marked paid.
    receiptNumber: { type: String, unique: true, sparse: true },
    // Legacy: Stripe was removed as a gateway. Kept only so fees paid through it keep their record.
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

// The real duplicate-invoice guard (spec: "Duplicate invoices must be prevented with database
// indexes") — only applies to schedule-generated invoices; legacy manually-created Fees (schedule
// null) are excluded via the partial filter so they never collide with each other.
feeSchema.index(
  { schedule: 1, billingPeriod: 1, 'installment.number': 1 },
  { unique: true, partialFilterExpression: { schedule: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Fee', feeSchema);
