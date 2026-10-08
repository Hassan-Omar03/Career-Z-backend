const WalletTransaction = require('../models/WalletTransaction');
const JazzCashPayment = require('../models/JazzCashPayment');
const Fee = require('../models/Fee');
const CoursePurchase = require('../models/CoursePurchase');
const payment = require('./payment.controller');
const jazzcash = require('./jazzcash.controller');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// Bounded, owner-scoped recovery after refresh/checkout close. Provider APIs remain the source
// of truth and existing settlement transactions prevent duplicate wallet/enrollment effects.
const syncPendingPayments = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 7 * 86400000);
  const [wallets, jazz, fees, courses] = await Promise.all([
    WalletTransaction.find({ user: req.user._id, type: 'topup', status: 'pending', createdAt: { $gte: since }, $or: [{ paddleTransactionId: { $type: 'string' } }, { nowPaymentsId: { $type: 'string' } }] }).sort({ createdAt: -1 }).limit(5),
    JazzCashPayment.find({ payer: req.user._id, status: { $in: ['pending', 'awaiting_payment'] }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5),
    Fee.find({ student: req.user._id, status: 'processing', paddleTransactionId: { $type: 'string' }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(5),
    CoursePurchase.find({ student: req.user._id, provider: 'paddle', status: 'pending', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5)
  ]);
  const jobs = [
    ...wallets.map(row => ({ handler: row.nowPaymentsId ? payment.syncCryptoWalletTopup : payment.syncWalletTopup, params: row.nowPaymentsId ? { paymentId: row.nowPaymentsId } : { transactionId: row.paddleTransactionId } })),
    ...jazz.map(row => ({ handler: jazzcash.syncPayment, params: { txnRefNo: row.txnRefNo } })),
    ...fees.map(row => ({ handler: payment.syncPaddleFeeStatus, params: { feeId: row._id } })),
    ...courses.map(row => ({ handler: payment.syncPaddleCourseStatus, params: { courseId: row.course, transactionId: row.providerCheckoutId } }))
  ];
  let completed = 0;
  await Promise.all(jobs.map(job => new Promise(resolve => {
      const result = { status() { return this; }, json(value) { if (['paid', 'completed'].includes(value.data?.status)) completed++; resolve(); } };
      Promise.resolve(job.handler({ ...req, params: job.params }, result, () => resolve())).catch(() => resolve());
    })));
  return ok(res, { checked: jobs.length, completed });
});
module.exports = { syncPendingPayments };
