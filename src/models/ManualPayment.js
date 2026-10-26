const mongoose = require('mongoose');

// One manual purchase, paid in two transfers the buyer makes from their own bank or wallet:
//   1. CareerZ's service fee to the CareerZ account (QR) — or the whole amount when CareerZ is
//      the seller (plan, featured job, wallet top-up);
//   2. the price to the seller's own account (institute, teacher, marketplace seller, student).
// A CareerZ finance admin checks both receipts (and can call either side) before the purchase
// is granted. Nothing changes on the item until then.
const legSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  transactionId: { type: String, default: '' },
  paidOn: { type: Date, default: null },
  file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', default: null },
  submittedAt: { type: Date, default: null }
}, { _id: false });

const manualPaymentSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['fee', 'course', 'tutoring', 'marketplace_order', 'donation', 'featured_job', 'subscription', 'wallet_topup', 'agent_commission', 'recruitment_invoice', 'sponsorship_payment'], required: true, index: true },
  title: { type: String, required: true },
  // Who pays and who receives, with the phone numbers the admin calls to check.
  payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  payerSnapshot: { name: String, email: String, phone: String },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  recipientSnapshot: { name: String, email: String, phone: String, account: { method: String, bankName: String, accountTitle: String, accountNumber: String } },
  // What the purchase is for.
  fee: { type: mongoose.Schema.Types.ObjectId, ref: 'Fee', default: null },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
  tutoringLink: { type: mongoose.Schema.Types.ObjectId, ref: 'TeacherStudentLink', default: null },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  fundingRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FundingRequest', default: null },
  donation: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', default: null },
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
  plan: { type: String, default: '' },
  agentCommission: { type: mongoose.Schema.Types.ObjectId, ref: 'Commission', default: null },
  recruitmentInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentInvoice', default: null },
  sponsorship: { type: mongoose.Schema.Types.ObjectId, ref: 'Sponsorship', default: null },
  // Master 6.10: for a large donation the donor says where the money comes from.
  sourceOfFunds: { type: String, default: '' },
  // Amounts: price goes to the seller; CareerZ's fee is charged on top of it.
  currency: { type: String, required: true },
  price: { type: Number, required: true },
  commissionRate: { type: Number, default: 0 },
  commission: { type: Number, default: 0 },
  sellerAmount: { type: Number, default: 0 },
  commissionLeg: { type: legSchema, default: null },
  sellerLeg: { type: legSchema, default: null },
  // Every transaction id ever used, so one receipt can never be submitted twice.
  txnKeys: { type: [String], default: [] },
  // Only one open payment per item at a time.
  openKey: { type: String, default: null },
  // With a CareerZ fee the buyer goes in two steps: the fee receipt first (commission_submitted);
  // only after CareerZ confirms it (commission_verified) is the seller's account shown and the
  // seller receipt taken (submitted), then the final approval.
  status: { type: String, enum: ['commission_submitted', 'commission_verified', 'submitted', 'approved', 'rejected'], default: 'submitted', index: true },
  recipientConfirmation: { received: { type: Boolean, default: null }, note: String, at: Date },
  review: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: Date, note: String },
  history: [{ action: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now }, note: String }]
}, { timestamps: true });

manualPaymentSchema.index({ txnKeys: 1 }, { unique: true, partialFilterExpression: { txnKeys: { $type: 'string' } } });
manualPaymentSchema.index({ openKey: 1 }, { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } });

module.exports = mongoose.model('ManualPayment', manualPaymentSchema);
