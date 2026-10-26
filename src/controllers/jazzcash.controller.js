const Fee = require('../models/Fee');
const CoursePurchase = require('../models/CoursePurchase');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const JazzCashPayment = require('../models/JazzCashPayment');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const { settle } = require('../services/settlement.service');
const jazzCash = require('../services/jazzcash.service');
const env = require('../config/env');
const { isAllowedOrigin } = require('../utils/allowedOrigins');
const safepay = require('../services/safepay.service');

const FEE_COMMISSION_KEY = 'fee_commission_percent';
// A checkout JazzCash still has no record of after this long was never completed on its page.
const NEVER_REACHED_AFTER_MS = 60 * 60 * 1000;

// Each checkout picks its gateway: { gateway: 'safepay' } in the body, else JazzCash.
const gatewayOf = (req) => (req.body?.gateway === 'safepay' ? 'safepay' : 'jazzcash');
const GATEWAY_NAME = { jazzcash: 'JazzCash', safepay: 'Safepay' };

function assertConfigured(gateway = 'jazzcash') {
  if (!require('../utils/onlinePayments').onlinePaymentsEnabled()) throw new AppError('Online payment is switched off. Pay by bank transfer and upload the receipts.', 503);
  if (gateway === 'safepay') {
    if (!safepay.isConfigured()) throw new AppError('Safepay is not set up yet — ask the Super Admin to configure SAFEPAY_API_KEY and SAFEPAY_SECRET_KEY.', 503);
    return;
  }
  if (!jazzCash.isJazzCashConfigured()) {
    throw new AppError('JazzCash is not set up yet — ask the Super Admin to configure JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD and JAZZCASH_INTEGRITY_SALT.', 503);
  }
}

// JazzCash only charges PKR. Other currencies convert through the platform's own USD rates;
// the fee/course/wallet record itself always keeps the currency the user agreed to.
async function toPaisa(amount, currency) {
  const cur = normalizeCurrency(currency);
  let pkr = Number(amount);
  if (cur !== 'PKR') {
    const Currency = require('../models/Currency');
    const [from, pkrRate] = await Promise.all([
      Currency.findOne({ code: cur }).select('exchangeRateToUSD'),
      Currency.findOne({ code: 'PKR' }).select('exchangeRateToUSD')
    ]);
    if (!from?.exchangeRateToUSD || !pkrRate?.exchangeRateToUSD) {
      throw new AppError(`No exchange rate configured to convert ${cur} to PKR — ask the Super Admin to set one.`, 422);
    }
    pkr = (pkr * from.exchangeRateToUSD) / pkrRate.exchangeRateToUSD;
  }
  const paisa = Math.round(pkr * 100);
  if (!Number.isSafeInteger(paisa) || paisa < 100) throw new AppError('JazzCash payments must be at least PKR 1.00.', 422);
  return paisa;
}

// Remembers which frontend started the checkout (local dev vs. deployed) — only if it is one of
// our own allow-listed origins, so the return can never be turned into an open redirect.
function returnOriginOf(req) {
  const origin = String(req.headers?.origin || '').replace(/\/+$/, '');
  return isAllowedOrigin(origin) ? origin : '';
}

// JAZZCASH_RETURN_URL when set; otherwise this backend's own public address, taken from the
// request (behind Vercel's proxy, x-forwarded-proto carries the real https scheme).
function returnUrlFor(req) {
  if (env.jazzCash.returnUrl) return env.jazzCash.returnUrl;
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || `localhost:${env.port}`;
  return `${proto}://${host}/api/payments/jazzcash/return`;
}

// The public address of this backend's Safepay return/cancel endpoints.
function safepayUrl(req, path) {
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || `localhost:${env.port}`;
  return `${process.env.SAFEPAY_RETURN_BASE || `${proto}://${host}`}/api/payments/safepay/${path}`;
}

async function checkoutResponse(req, res, payment, description) {
  if (payment.provider === 'safepay') {
    const tracker = await safepay.createTracker(payment.amountPaisa / 100);
    payment.gatewayTracker = tracker;
    await payment.save();
    const redirectUrl = safepay.checkoutUrl({ tracker, orderId: payment.txnRefNo, redirectUrl: safepayUrl(req, 'return'), cancelUrl: `${safepayUrl(req, 'cancel')}?ref=${encodeURIComponent(payment.txnRefNo)}` });
    return ok(res, { gateway: 'safepay', redirectUrl, txnRefNo: payment.txnRefNo });
  }
  const fields = jazzCash.buildCheckoutFields({
    txnRefNo: payment.txnRefNo, amountPaisa: payment.amountPaisa,
    billReference: payment.kind, description, returnUrl: returnUrlFor(req)
  });
  return ok(res, { actionUrl: jazzCash.checkoutUrl(), fields, txnRefNo: payment.txnRefNo });
}

// POST /api/payments/jazzcash/fees/:feeId/checkout
const createFeeCheckout = asyncHandler(async (req, res) => {
  const gateway = gatewayOf(req);
  assertConfigured(gateway);
  const { assertCanPayFee } = require('./payment.controller');
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  await assertCanPayFee(fee, req.user);
  const owed = require('../services/feeSettlement.service').assertPayableOnline(fee);

  const amountPaisa = await toPaisa(owed, fee.currency || 'PKR');
  const payment = await JazzCashPayment.create({
    txnRefNo: jazzCash.newTxnRefNo(), provider: gateway, kind: 'fee', payer: req.user._id, fee: fee._id,
    amountPaisa, amount: owed, currency: normalizeCurrency(fee.currency || 'PKR'),
    previousFeeStatus: fee.status === 'processing' ? 'pending' : fee.status, returnOrigin: returnOriginOf(req)
  });
  fee.status = 'processing';
  await fee.save();
  return checkoutResponse(req, res, payment, fee.title);
});

// POST /api/payments/jazzcash/courses/:courseId/checkout
const createCourseCheckout = asyncHandler(async (req, res) => {
  const gateway = gatewayOf(req);
  assertConfigured(gateway);
  const { loadPayableCourse } = require('./payment.controller');
  const { course, amountMinor, currency } = await loadPayableCourse(req.params.courseId, req.user._id);
  const amountPaisa = await toPaisa(amountMinor / 100, currency);
  const txnRefNo = jazzCash.newTxnRefNo();
  const purchase = await CoursePurchase.create({
    course: course._id, student: req.user._id, provider: gateway, providerCheckoutId: txnRefNo,
    amountMinor, currency, gatewayAmountMinor: amountPaisa, gatewayCurrency: 'PKR'
  });
  const payment = await JazzCashPayment.create({
    txnRefNo, provider: gateway, kind: 'course', payer: req.user._id, coursePurchase: purchase._id,
    amountPaisa, amount: amountMinor / 100, currency, returnOrigin: returnOriginOf(req)
  });
  return checkoutResponse(req, res, payment, course.title);
});

// POST /api/payments/jazzcash/wallet/topup
const createWalletTopup = asyncHandler(async (req, res) => {
  const gateway = gatewayOf(req);
  assertConfigured(gateway);
  const { amount, currency } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  const amountPaisa = await toPaisa(amount, cur);
  const txnRefNo = jazzCash.newTxnRefNo();
  const pending = await WalletTransaction.create({
    user: req.user._id, type: 'topup', amount, currency: cur, status: 'pending', reference: txnRefNo, note: `${GATEWAY_NAME[gateway]} top-up`
  });
  const payment = await JazzCashPayment.create({
    txnRefNo, provider: gateway, kind: 'wallet_topup', payer: req.user._id, walletTransaction: pending._id,
    amountPaisa, amount, currency: cur, returnOrigin: returnOriginOf(req)
  });
  return checkoutResponse(req, res, payment, `Wallet top-up ${cur} ${amount}`);
});

// Shared by the featured-job, plan and tuition checkouts: one JazzCash attempt pointing at the
// record it pays for. `createRefs` makes that record (only once the amount converts) and returns
// its reference: { featuredListing } / { subscriptionPurchase } / { tutoringLink }.
async function startCheckout(req, res, { kind, amount, currency, description, createRefs }) {
  const gateway = gatewayOf(req);
  assertConfigured(gateway);
  const amountPaisa = await toPaisa(amount, currency);
  const refs = await createRefs();
  const payment = await JazzCashPayment.create({
    txnRefNo: jazzCash.newTxnRefNo(), provider: gateway, kind, payer: req.user._id, ...refs,
    amountPaisa, amount, currency: normalizeCurrency(currency), returnOrigin: returnOriginOf(req)
  });
  return checkoutResponse(req, res, payment, description);
}

// POST /api/payments/jazzcash/jobs/:jobId/feature-checkout
const createFeaturedJobCheckout = asyncHandler(async (req, res) => {
  const { loadFeaturableJob } = require('./job.controller');
  const { job, fee, days } = await loadFeaturableJob(req.params.jobId, req.user._id);
  const FeaturedListing = require('../models/FeaturedListing');
  return startCheckout(req, res, {
    kind: 'featured_job', amount: fee, currency: 'USD', description: `Featured job ${job.title}`,
    createRefs: async () => ({ featuredListing: (await FeaturedListing.create({
      listingType: 'job', job: job._id, purchasedBy: req.user._id, amount: fee, currency: 'USD',
      paymentMethod: gatewayOf(req), status: 'pending',
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    }))._id })
  });
});

// Applies a JazzCash outcome to the stored checkout, exactly once. Everything credited comes
// from our own JazzCashPayment / Fee / CoursePurchase / WalletTransaction records.
// `outcome` is given directly by gateways that report a state rather than a JazzCash code.
async function applyOutcome(txnRefNo, { code, message = '', rrn = '', outcome: given }) {
  const outcome = given || jazzCash.outcomeOf(code);
  return settle(async (session) => {
    const payment = await JazzCashPayment.findOne({ txnRefNo }).session(session);
    if (!payment) throw new AppError('JazzCash payment not found.', 404);
    if (payment.status === 'paid') return [];
    Object.assign(payment, { responseCode: code, responseMessage: message, retrievalReferenceNo: rrn || payment.retrievalReferenceNo });

    if (outcome === 'awaiting_payment' || outcome === 'failed') {
      if (outcome === 'failed' && payment.status !== 'failed') await releaseFailed(payment, session);
      payment.status = outcome;
      await payment.save({ session });
      return [];
    }

    payment.status = 'paid';
    payment.paidAt = new Date();
    await payment.save({ session });
    const receiptId = rrn || txnRefNo;
    if (payment.kind === 'fee') return settleFee(payment, receiptId, session);
    if (payment.kind === 'course') return settleCourse(payment, receiptId, session);
    if (payment.kind === 'featured_job') return settleFeaturedJob(payment, receiptId, session);
    if (payment.kind === 'subscription') return settleSubscription(payment, receiptId, session);
    if (payment.kind === 'tutoring_fee') return settleTutoring(payment, receiptId, session);
    return settleWalletTopup(payment, receiptId, session);
  });
}

async function releaseFailed(payment, session) {
  if (payment.kind === 'fee') {
    await Fee.updateOne({ _id: payment.fee, status: 'processing' }, { $set: { status: payment.previousFeeStatus || 'pending' } }, { session });
  } else if (payment.kind === 'wallet_topup') {
    await WalletTransaction.updateOne({ _id: payment.walletTransaction, status: 'pending' }, { $set: { status: 'rejected' } }, { session });
  } else if (payment.kind === 'featured_job') {
    await require('../models/FeaturedListing').updateOne({ _id: payment.featuredListing, status: 'pending' }, { $set: { status: 'failed' } }, { session });
  } else if (payment.kind === 'subscription') {
    await require('../models/SubscriptionPurchase').updateOne({ _id: payment.subscriptionPurchase, status: 'pending' }, { $set: { status: 'failed' } }, { session });
  }
}

async function settleFeaturedJob(payment, receiptId, session) {
  const listing = await require('../models/FeaturedListing').findById(payment.featuredListing).session(session);
  if (!listing) throw new AppError('Featured job checkout not found.', 404);
  return require('./webhook.controller').settleFeaturedListing(listing, receiptId, session);
}

async function settleSubscription(payment, receiptId, session) {
  const purchase = await require('../models/SubscriptionPurchase').findById(payment.subscriptionPurchase).session(session);
  if (!purchase) throw new AppError('Subscription checkout not found.', 404);
  return require('./webhook.controller').settleSubscriptionPurchase(purchase, receiptId, session);
}

async function settleTutoring(payment, receiptId, session) {
  const link = await require('../models/TeacherStudentLink').findById(payment.tutoringLink).session(session);
  if (!link) throw new AppError('Tuition checkout not found.', 404);
  return require('./webhook.controller').settleTutoringFee(link, { receiptId, payerId: payment.payer, amount: payment.amount, currency: payment.currency }, session);
}

async function settleFee(payment, receiptId, session) {
  const fee = await Fee.findById(payment.fee).session(session);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if ((fee.paymentHistory || []).some((p) => p.transactionId === receiptId)) return [];
  // JazzCash marks the fee 'processing' while the customer is on its page; settle from the real status.
  if (fee.status === 'processing') fee.status = payment.previousFeeStatus || 'pending';
  const { settleOnlineFee } = require('./webhook.controller');
  const name = GATEWAY_NAME[payment.provider] || 'JazzCash';
  return settleOnlineFee(fee, { amount: payment.amount, method: payment.provider || 'jazzcash', paidVia: name, transactionId: receiptId, payerId: payment.payer }, name, session);
}

async function settleCourse(payment, receiptId, session) {
  const purchase = await CoursePurchase.findById(payment.coursePurchase).session(session);
  if (!purchase) throw new AppError('Course checkout not found.', 404);
  const { settleCoursePurchase } = require('./webhook.controller');
  return settleCoursePurchase(purchase, receiptId, session);
}

async function settleWalletTopup(payment, receiptId, session) {
  const pending = await WalletTransaction.findById(payment.walletTransaction).session(session);
  if (!pending) throw new AppError('Wallet top-up record not found.', 404);
  if (pending.status === 'completed') return [];
  pending.status = 'completed';
  await pending.save({ session });
  await Wallet.findOneAndUpdate(
    { user: pending.user, currency: pending.currency }, { $inc: { available: pending.amount } },
    { upsert: true, session }
  );
  return [{ userId: pending.user, payload: { title: `Wallet topped up: ${pending.currency} ${pending.amount.toFixed(2)}`, body: `${GATEWAY_NAME[payment.provider] || 'JazzCash'} receipt ${receiptId}`, sentBy: null } }];
}

function frontendUrl(payment) {
  if (payment?.returnOrigin) return payment.returnOrigin;
  return env.clientUrl.split(',')[0].trim().replace(/\/+$/, '');
}

// POST /api/payments/jazzcash/return — JazzCash posts the payer's BROWSER here (form-encoded)
// after the hosted page. Only a correctly signed response for the exact amount we stored is
// applied; anything else is ignored. Always ends by redirecting the payer back to the app.
const handleReturn = asyncHandler(async (req, res) => {
  let body = req.body || {};
  if (typeof body.Response === 'string') {
    try { body = JSON.parse(body.Response); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  jazzCash.debugLog('return (browser post)', body);
  const txnRefNo = String(body.pp_TxnRefNo || '');
  let result = 'error';
  let payment = null;
  try {
    payment = txnRefNo ? await JazzCashPayment.findOne({ txnRefNo }) : null;
    const checks = {
      paymentFound: Boolean(payment),
      signatureValid: jazzCash.isJazzCashConfigured() && jazzCash.verifySecureHash(body),
      amountMatches: Boolean(payment) && String(body.pp_Amount) === String(payment.amountPaisa),
      merchantMatches: body.pp_MerchantID === env.jazzCash.merchantId,
      currencyPKR: body.pp_TxnCurrency === 'PKR'
    };
    jazzCash.debugLog(`return checks ${txnRefNo} (JazzCash said ${body.pp_ResponseCode || '-'}: ${body.pp_ResponseMessage || '-'})`, checks);
    if (payment) {
      // Keep JazzCash's exact reply on the record (hash masked) so a failure can be diagnosed later.
      const { pp_SecureHash, pp_Password, ...reply } = body;
      await JazzCashPayment.updateOne({ _id: payment._id }, { $set: { gatewayReply: reply } });
    }
    if (Object.values(checks).every(Boolean)) {
      await applyOutcome(txnRefNo, { code: String(body.pp_ResponseCode || ''), message: String(body.pp_ResponseMessage || ''), rrn: String(body.pp_RetreivalReferenceNo || body.pp_RetrievalReferenceNo || '') });
      result = (await JazzCashPayment.findById(payment._id)).status;
    }
  } catch (error) {
    console.error('[jazzcash return] processing failed:', error.message);
  }
  const refreshed = payment ? await JazzCashPayment.findById(payment._id) : null;
  const query = new URLSearchParams({ jazzcash: result, ref: txnRefNo });
  if (result !== 'paid' && refreshed?.responseCode) query.set('code', refreshed.responseCode);
  return res.redirect(303, `${frontendUrl(payment)}/dashboard?${query}`);
});

// GET /api/payments/jazzcash/:txnRefNo/sync — asks JazzCash directly (server-to-server) for the
// latest status, e.g. after a voucher is paid over the counter or if the return never arrived.
const syncPayment = asyncHandler(async (req, res) => {
  const payment = await JazzCashPayment.findOne({ txnRefNo: req.params.txnRefNo, payer: req.user._id });
  if (!payment) throw new AppError('JazzCash payment not found.', 404);
  if (payment.provider === 'safepay') return require('./safepay.controller').syncPayment(req, res);
  if (payment.status !== 'paid') {
    assertConfigured();
    const inquiry = await jazzCash.inquire(payment.txnRefNo);
    const code = inquiry.pp_PaymentResponseCode;
    if (inquiry.pp_ResponseCode === '000' && code) {
      await applyOutcome(payment.txnRefNo, { code: String(code), message: String(inquiry.pp_PaymentResponseMessage || ''), rrn: String(inquiry.pp_RetreivalReferenceNo || inquiry.pp_RetrievalReferenceNo || '') });
    } else if (inquiry.pp_ResponseCode === '199' && !code && Date.now() - payment.createdAt.getTime() > NEVER_REACHED_AFTER_MS) {
      // JazzCash has no transaction for this reference (the payer never completed its page, or
      // it was routed elsewhere). Close it so recovery stops re-asking JazzCash every minute.
      await applyOutcome(payment.txnRefNo, { code: 'NOT_FOUND', message: String(inquiry.pp_ResponseMessage || 'JazzCash has no transaction for this reference.') });
    }
  }
  const refreshed = await JazzCashPayment.findById(payment._id);
  return ok(res, { status: refreshed.status, responseMessage: refreshed.responseMessage, responseCode: refreshed.responseCode });
});

// Signed server-to-server notifications use the same amount/merchant/currency checks as return.
const handleIpn = asyncHandler(async (req, res) => {
  const body = req.body || {};
  jazzCash.debugLog('IPN (server notification)', body);
  if (!jazzCash.isJazzCashConfigured() || !jazzCash.verifySecureHash(body)) throw new AppError('JazzCash signature verification failed.', 400);
  const payment = await JazzCashPayment.findOne({ txnRefNo: String(body.pp_TxnRefNo || '') });
  if (!payment || String(body.pp_Amount) !== String(payment.amountPaisa)
    || body.pp_MerchantID !== env.jazzCash.merchantId || body.pp_TxnCurrency !== 'PKR') throw new AppError('JazzCash notification does not match checkout.', 422);
  await applyOutcome(payment.txnRefNo, { code: String(body.pp_ResponseCode || ''), message: String(body.pp_ResponseMessage || ''), rrn: String(body.pp_RetreivalReferenceNo || body.pp_RetrievalReferenceNo || '') });
  return ok(res, { received: true });
});

// GET /api/payments/jazzcash/config — whether to show "Pay with JazzCash" at all.
// returnUrl is public (it's posted in every checkout form) — shown so an admin can check it
// matches the Return URL registered on the JazzCash portal.
const getConfig = asyncHandler(async (req, res) => ok(res, { enabled: require('../utils/onlinePayments').onlinePaymentsEnabled() && jazzCash.isJazzCashConfigured(), environment: env.jazzCash.environment, returnUrl: returnUrlFor(req) }));

module.exports = {
  createFeeCheckout, createCourseCheckout, createWalletTopup, createFeaturedJobCheckout, startCheckout,
  handleReturn, handleIpn, syncPayment, getConfig, applyOutcome, frontendUrl, assertConfigured
};
