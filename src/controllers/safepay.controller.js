const JazzCashPayment = require('../models/JazzCashPayment');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const safepay = require('../services/safepay.service');

// Safepay's hosted page sends the payer back here. Nothing is trusted from the browser: the
// attempt must be ours, the tracker must match it, the signature must be valid, and Safepay itself
// must say the tracker is paid for our amount. Settlement is the same as every online payment
// (fee to the institute wallet less commission, course, tutoring, wallet top-up, plan, featured job).
async function apply(payment) {
  const { applyOutcome } = require('./jazzcash.controller');
  const data = await safepay.fetchTracker(payment.gatewayTracker);
  const outcome = safepay.outcomeOf(data, payment.amountPaisa / 100);
  await JazzCashPayment.updateOne({ _id: payment._id }, { $set: { gatewayReply: { state: data.state, amount: data.amount, currency: data.currency, reference: data.transaction?.reference || data.transaction?.token || '' } } });
  if (outcome === 'mismatch') throw new AppError('Safepay payment does not match this checkout.', 422);
  if (outcome === 'awaiting_payment' && payment.status === 'awaiting_payment') return;
  await applyOutcome(payment.txnRefNo, { outcome, message: data.state, rrn: String(data.transaction?.reference || data.transaction?.token || payment.gatewayTracker) });
}

const handleReturn = asyncHandler(async (req, res) => {
  const p = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const ref = String(p.order_id || p.orderId || '');
  const tracker = String(p.tracker || p.beacon || '');
  let result = 'error';
  let payment = null;
  try {
    payment = ref ? await JazzCashPayment.findOne({ txnRefNo: ref, provider: 'safepay' }) : null;
    if (payment && payment.gatewayTracker === tracker && safepay.verifySignature(tracker, p.sig)) {
      await apply(payment);
      result = (await JazzCashPayment.findById(payment._id)).status;
    }
  } catch (error) {
    console.error('[safepay return] processing failed:', error.message);
  }
  const { frontendUrl } = require('./jazzcash.controller');
  return res.redirect(303, `${frontendUrl(payment)}/dashboard?${new URLSearchParams({ safepay: result, ref })}`);
});

// The payer left Safepay's page without paying: release the fee / top-up / listing.
const handleCancel = asyncHandler(async (req, res) => {
  const ref = String(req.query.ref || '');
  const payment = ref ? await JazzCashPayment.findOne({ txnRefNo: ref, provider: 'safepay' }) : null;
  if (payment && payment.status !== 'paid') {
    try { await apply(payment); } catch { /* fall through to cancel */ }
    const fresh = await JazzCashPayment.findById(payment._id);
    if (fresh.status !== 'paid') await require('./jazzcash.controller').applyOutcome(ref, { outcome: 'failed', message: 'Cancelled on Safepay' });
  }
  const { frontendUrl } = require('./jazzcash.controller');
  const status = payment ? (await JazzCashPayment.findById(payment._id)).status : 'error';
  return res.redirect(303, `${frontendUrl(payment)}/dashboard?${new URLSearchParams({ safepay: status === 'paid' ? 'paid' : 'cancelled', ref })}`);
});

// Asks Safepay directly for the latest state (after a refresh, or if the return never arrived).
const syncPayment = asyncHandler(async (req, res) => {
  const payment = await JazzCashPayment.findOne({ txnRefNo: req.params.txnRefNo, payer: req.user._id, provider: 'safepay' });
  if (!payment) throw new AppError('Payment not found.', 404);
  if (payment.status !== 'paid' && payment.status !== 'failed' && payment.gatewayTracker && safepay.isConfigured()) await apply(payment);
  const fresh = await JazzCashPayment.findById(payment._id);
  return ok(res, { status: fresh.status, responseMessage: fresh.responseMessage });
});

const getConfig = asyncHandler(async (req, res) => ok(res, { enabled: require('../utils/onlinePayments').onlinePaymentsEnabled() && safepay.isConfigured(), environment: safepay.config().environment }));

module.exports = { handleReturn, handleCancel, syncPayment, getConfig };
