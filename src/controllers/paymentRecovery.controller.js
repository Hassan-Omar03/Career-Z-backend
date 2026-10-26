const WalletTransaction = require('../models/WalletTransaction');
const JazzCashPayment = require('../models/JazzCashPayment');
const payment = require('./payment.controller');
const jazzcash = require('./jazzcash.controller');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// Bounded, owner-scoped recovery after refresh/checkout close. Provider APIs remain the source
// of truth and existing settlement transactions prevent duplicate wallet/enrollment effects.
const syncPendingPayments = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 7 * 86400000);
  const [crypto, jazz] = await Promise.all([
    WalletTransaction.find({ user: req.user._id, type: 'topup', status: 'pending', createdAt: { $gte: since }, nowPaymentsId: { $type: 'string' } }).sort({ createdAt: -1 }).limit(5),
    JazzCashPayment.find({ payer: req.user._id, status: { $in: ['pending', 'awaiting_payment'] }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5)
  ]);
  const jobs = [
    ...crypto.map(row => ({ handler: payment.syncCryptoWalletTopup, params: { paymentId: row.nowPaymentsId } })),
    ...jazz.map(row => ({ handler: jazzcash.syncPayment, params: { txnRefNo: row.txnRefNo } }))
  ];
  let completed = 0;
  await Promise.all(jobs.map(job => new Promise(resolve => {
      const result = { status() { return this; }, json(value) { if (['paid', 'completed'].includes(value.data?.status)) completed++; resolve(); } };
      Promise.resolve(job.handler({ ...req, params: job.params }, result, () => resolve())).catch(() => resolve());
    })));
  return ok(res, { checked: jobs.length, completed });
});
module.exports = { syncPendingPayments };
