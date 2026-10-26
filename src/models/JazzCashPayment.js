const mongoose = require('mongoose');

// One JazzCash checkout attempt. Created BEFORE the payer is sent to JazzCash, so settlement
// always credits from OUR stored purpose/amount — never from fields in the browser-posted return.
const jazzCashPaymentSchema = new mongoose.Schema({
  txnRefNo: { type: String, required: true, unique: true },
  // Which hosted checkout took the payment. Safepay attempts use the same record and settlement.
  provider: { type: String, enum: ['jazzcash', 'safepay'], default: 'jazzcash', index: true },
  // Safepay's tracker token for this attempt (checked on return before anything is credited).
  gatewayTracker: { type: String, default: '', index: true },
  kind: { type: String, enum: ['fee', 'course', 'wallet_topup', 'featured_job', 'subscription', 'tutoring_fee'], required: true },
  payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fee: { type: mongoose.Schema.Types.ObjectId, ref: 'Fee', default: null },
  coursePurchase: { type: mongoose.Schema.Types.ObjectId, ref: 'CoursePurchase', default: null },
  walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
  featuredListing: { type: mongoose.Schema.Types.ObjectId, ref: 'FeaturedListing', default: null },
  subscriptionPurchase: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPurchase', default: null },
  tutoringLink: { type: mongoose.Schema.Types.ObjectId, ref: 'TeacherStudentLink', default: null },
  // What JazzCash charges (always PKR, in paisa) vs. what the record itself is priced in.
  amountPaisa: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  // A fee goes to 'processing' while at JazzCash; this restores it if the payment fails.
  previousFeeStatus: { type: String, default: '' },
  // The (allow-listed) frontend the checkout started from, so the payer returns to the same app.
  returnOrigin: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'awaiting_payment', 'paid', 'failed'], default: 'pending' },
  responseCode: { type: String, default: '' },
  responseMessage: { type: String, default: '' },
  retrievalReferenceNo: { type: String, default: '' },
  // JazzCash's last browser-return payload, minus its secure hash — for diagnosing failures.
  gatewayReply: { type: mongoose.Schema.Types.Mixed, default: null },
  paidAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('JazzCashPayment', jazzCashPaymentSchema);
