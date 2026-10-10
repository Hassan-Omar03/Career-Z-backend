const Fee = require('../models/Fee');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const CoursePurchase = require('../models/CoursePurchase');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const paddleService = require('../services/paddle.service');
const nowPaymentsService = require('../services/nowpayments.service');
const WalletTransaction = require('../models/WalletTransaction');
const env = require('../config/env');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const crypto = require('crypto');

// Paddle Billing only accepts a fixed set of transaction currencies — PKR/INR/AED/SAR/etc. are
// rejected outright with a generic "invalid request" error (same limitation already hit and
// fixed for NOWPayments' price_currency). This is the safe subset Paddle definitely supports;
// anything outside it gets converted to USD for the Paddle side only — our own stored record
// (Fee.currency, Wallet currency, etc.) always keeps the amount the user actually agreed to.
const PADDLE_DIRECT_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD']);
async function resolvePaddleAmount(amount, currency) {
  const cur = normalizeCurrency(currency);
  if (PADDLE_DIRECT_CURRENCIES.has(cur)) return { amount, currencyCode: cur };
  const Currency = require('../models/Currency');
  const rate = await Currency.findOne({ code: cur }).select('exchangeRateToUSD');
  if (!rate?.exchangeRateToUSD) throw new AppError(`No USD exchange rate configured for ${cur} — ask the Super Admin to set one, or pay in USD.`, 422);
  return { amount: Number((amount * rate.exchangeRateToUSD).toFixed(2)), currencyCode: 'USD' };
}

// Same authorization as the self-report fee-payment endpoints (student themselves, or any
// approved parent/guardian/sponsor link) — paying a fee doesn't require being a legal guardian.
async function assertCanPayFee(fee, user) {
  if (fee.student.toString() === user._id.toString()) return;
  const link = await ParentChildLink.findOne({ parent: user._id, student: fee.student, status: 'approved' });
  if (!link || link.permissions?.payFees === false) throw new AppError('You are not authorized to pay this fee.', 403);
}

async function loadPayableCourse(courseId, userId) {
  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found.', 404);
  if (!course.published) throw new AppError('This course is not published yet.', 400);
  if (course.isFree) throw new AppError('This course is free. Use the enroll action.', 400);
  if (await Enrollment.exists({ course: course._id, student: userId })) throw new AppError('Already enrolled.', 409);
  const amount = Number(course.price);
  const currency = normalizeCurrency(course.currency);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new AppError('Course price must be a positive amount with at most two decimal places.', 422);
  }
  return { course, amountMinor: Math.round(amount * 100), currency };
}

const createPaddleCourseCheckout = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) throw new AppError('Paddle checkout is not configured.', 503);
  const { course, amountMinor, currency } = await loadPayableCourse(req.params.courseId, req.user._id);
  const { amount: paddleAmount, currencyCode: paddleCurrency } = await resolvePaddleAmount(amountMinor / 100, currency);
  const gatewayAmountMinor = Math.round(paddleAmount * 100);
  const transaction = await paddleService.createTransaction({
    title: course.title, amount: paddleAmount, currencyCode: paddleCurrency,
    customerEmail: req.user.email,
    metadata: { kind: 'course', courseId: course._id.toString(), studentId: req.user._id.toString() }
  });
  await CoursePurchase.create({ course: course._id, student: req.user._id, provider: 'paddle',
    providerCheckoutId: transaction.id, amountMinor, currency,
    gatewayAmountMinor, gatewayCurrency: paddleCurrency });
  return ok(res, { transactionId: transaction.id, status: transaction.status });
});

const syncPaddleCourseStatus = asyncHandler(async (req, res) => {
  const purchase = await CoursePurchase.findOne({ course: req.params.courseId, student: req.user._id,
    provider: 'paddle', providerCheckoutId: req.params.transactionId });
  if (!purchase) throw new AppError('Course checkout not found.', 404);
  if (purchase.status !== 'paid') {
    const transaction = await paddleService.getTransaction(purchase.providerCheckoutId);
    if (transaction.status === 'completed') {
      const { handleCoursePaddleCompleted } = require('./webhook.controller');
      await handleCoursePaddleCompleted(transaction);
    }
  }
  const refreshed = await CoursePurchase.findById(purchase._id);
  return ok(res, { status: refreshed.status });
});

// GET /api/payments/paddle/config — frontend needs the client-side token + environment before
// it can load Paddle.js at all (this client token is public/safe to expose).
const getPaddleConfig = asyncHandler(async (req, res) => {
  return ok(res, {
    enabled: paddleService.isPaddleConfigured() && Boolean(env.paddle.clientToken),
    clientToken: env.paddle.clientToken || null,
    environment: env.paddle.environment
  });
});

// POST /api/payments/paddle/fees/:feeId/checkout — creates a real Paddle transaction. The fee is
// NOT marked paid here — only the Paddle webhook, after verifying its
// signature, does that. Creating a transaction just proves intent to pay.
const createPaddleTransaction = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET.', 503);
  }

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status === 'paid') throw new AppError('This fee has already been paid.', 400);
  await assertCanPayFee(fee, req.user);

  const { amount: paddleAmount, currencyCode: paddleCurrency } = await resolvePaddleAmount(fee.amount, fee.currency || 'USD');
  const transaction = await paddleService.createTransaction({
    title: fee.title,
    amount: paddleAmount,
    currencyCode: paddleCurrency,
    customerEmail: req.user.email,
    metadata: { feeId: fee._id.toString(), payerId: req.user._id.toString(), kind: 'fee' }
  });

  fee.status = 'processing';
  fee.paddleTransactionId = transaction.id;
  await fee.save();

  return ok(res, { transactionId: transaction.id, status: transaction.status });
});

// GET /api/payments/paddle/fees/:feeId/sync — actively asks Paddle "is this transaction done
// yet?" instead of waiting for a webhook. Local/dev environments can't receive Paddle's real
// webhook (localhost isn't reachable from the internet), so the frontend calls this right after
// closing the checkout overlay as a fallback path — production still relies on the webhook for
// real-time confirmation; this is a manual/best-effort top-up, not a replacement.
const syncPaddleFeeStatus = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  await assertCanPayFee(fee, req.user);

  if (fee.status === 'paid') return ok(res,require('../services/familyAccess.service').safeFee(fee));
  if (!fee.paddleTransactionId) throw new AppError('No Paddle transaction found for this fee yet.', 400);

  const transaction = await paddleService.getTransaction(fee.paddleTransactionId);
  if (transaction.status === 'completed') {
    const { handleFeePaddleCompleted } = require('./webhook.controller');
    await handleFeePaddleCompleted(transaction);
  }

  const refreshed = await Fee.findById(fee._id);
  return ok(res,require('../services/familyAccess.service').safeFee(refreshed));
});

// POST /api/payments/paddle/wallet/topup — creates a real Paddle transaction for a wallet
// top-up. Like the fee flow, the wallet is NOT credited here — only the webhook (or sync
// fallback below), after confirming the transaction actually completed, credits it. A pending
// WalletTransaction is created up front (same pattern as the crypto top-up) so the webhook
// credits from OUR stored amount/currency, never by re-deriving it from Paddle's payload.
const createWalletTopup = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET.', 503);
  }
  const { amount, currency } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  const { amount: paddleAmount, currencyCode: paddleCurrency } = await resolvePaddleAmount(amount, cur);

  const transaction = await paddleService.createTransaction({
    title: `Wallet top-up — ${cur} ${amount}`,
    amount: paddleAmount,
    currencyCode: paddleCurrency,
    customerEmail: req.user.email,
    metadata: { userId: req.user._id.toString(), currency: paddleCurrency, kind: 'wallet_topup' }
  });

  await WalletTransaction.create({
    user: req.user._id, type: 'topup', amount, currency: cur, status: 'pending', paddleTransactionId: transaction.id
  });

  return ok(res, { transactionId: transaction.id, status: transaction.status });
});

// GET /api/payments/paddle/wallet/topup/:transactionId/sync — same local-dev fallback pattern
// as the fee sync endpoint, for when Paddle's webhook can't reach localhost.
const syncWalletTopup = asyncHandler(async (req, res) => {
  const transaction = await paddleService.getTransaction(req.params.transactionId);
  if (transaction.custom_data?.kind !== 'wallet_topup' || transaction.custom_data?.userId !== req.user._id.toString()) {
    throw new AppError('Not your wallet top-up transaction.', 403);
  }

  if (transaction.status === 'completed') {
    const { handleWalletTopupCompleted } = require('./webhook.controller');
    await handleWalletTopupCompleted(transaction);
  }
  return ok(res, { status: transaction.status });
});

// GET /api/payments/nowpayments/config — which crypto currencies are actually available.
const getNowPaymentsConfig = asyncHandler(async (req, res) => {
  return ok(res, { configured: nowPaymentsService.isNowPaymentsConfigured(), currencies: nowPaymentsService.SUPPORTED_CURRENCIES });
});

// POST /api/payments/nowpayments/wallet/topup — creates a real NOWPayments crypto payment
// (USDT TRC20 / BTC / ETH). Like the Paddle top-up, the wallet is NOT credited here — only the
// IPN webhook (or the sync fallback below), after the crypto network actually confirms, credits
// it. A pending WalletTransaction is created up front so the webhook has something to verify the
// amount/currency/owner against instead of trusting the provider payload blindly.
const createCryptoWalletTopup = asyncHandler(async (req, res) => {
  if (!nowPaymentsService.isNowPaymentsConfigured()) {
    throw new AppError('Crypto payments are not set up yet — ask the Super Admin to configure NOWPAYMENTS_API_KEY and NOWPAYMENTS_IPN_SECRET.', 503);
  }
  const { amount, currency, payCurrency } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  if (!nowPaymentsService.SUPPORTED_CURRENCIES[payCurrency]) {
    throw new AppError(`payCurrency must be one of: ${Object.keys(nowPaymentsService.SUPPORTED_CURRENCIES).join(', ')}.`, 422);
  }

    // NOWPayments only recognizes a handful of major fiat codes as price_currency (usd, eur, gbp,
  // ...) — PKR/INR/AED/SAR/etc. are rejected outright. It's only used to work out how much crypto
  // to charge, so converting to USD here (via the platform's own Currency exchange rates) keeps
  // every wallet currency choice working, while the wallet itself still credits in `cur`.
  const orderId = crypto.randomUUID();
  let priceAmount = amount;
  let priceCurrency = cur;
  if (cur !== 'USD') {
    const Currency = require('../models/Currency');
    const rate = await Currency.findOne({ code: cur }).select('exchangeRateToUSD');
    if (!rate?.exchangeRateToUSD) throw new AppError(`No USD exchange rate configured for ${cur} — ask the Super Admin to set one, or top up in USD.`, 422);
    priceAmount = Number((amount * rate.exchangeRateToUSD).toFixed(2));
    priceCurrency = 'usd';
  }

  const payment = await nowPaymentsService.createPayment({
    priceAmount,
    priceCurrency,
    payCurrency,
    orderId,
    orderDescription: `Wallet top-up — ${cur} ${amount}`,
    ipnCallbackUrl: env.serverUrl ? `${env.serverUrl.replace(/\/+$/, '')}/api/webhooks/nowpayments`
      : req.headers?.['x-forwarded-proto'] === 'https' && req.headers?.host ? `https://${req.headers.host}/api/webhooks/nowpayments` : undefined
  });

  await WalletTransaction.create({
    user: req.user._id, type: 'topup', amount, currency: cur, status: 'pending',
    nowPaymentsId: String(payment.payment_id), gatewayOrderId: orderId, gatewayPriceAmount: priceAmount, gatewayPriceCurrency: priceCurrency.toLowerCase(), gatewayPayCurrency: payCurrency, gatewayPayAmount: Number(payment.pay_amount), note: `Crypto top-up via ${nowPaymentsService.SUPPORTED_CURRENCIES[payCurrency]}`
  });

  return ok(res, {
    paymentId: payment.payment_id, payAddress: payment.pay_address, payAmount: payment.pay_amount,
    payCurrency: payment.pay_currency, status: payment.payment_status
  });
});

// GET /api/payments/nowpayments/wallet/topup/:paymentId/sync — local-dev fallback (NOWPayments'
// IPN can't reach localhost) — polls NOWPayments directly and credits if actually finished.
const syncCryptoWalletTopup = asyncHandler(async (req, res) => {
  const pending = await WalletTransaction.findOne({ user: req.user._id, nowPaymentsId: req.params.paymentId });
  if (!pending) throw new AppError('Crypto top-up not found.', 404);
  if (pending.status === 'pending') {
    const payment = await nowPaymentsService.getPaymentStatus(req.params.paymentId);
    if (payment.payment_status === 'finished') {
      const { handleNowPaymentsCompleted } = require('./webhook.controller');
      await handleNowPaymentsCompleted(payment);
    }
  }
  const refreshed = await WalletTransaction.findById(pending._id);
  return ok(res, { status: refreshed.status });
});

// POST /api/payments/paddle/jobs/:jobId/feature-checkout — the poster's own real, verified
// Paddle payment (replaces the old self-report "trust me I paid" endpoint). Creates a 'pending'
// FeaturedListing so the webhook/sync path has something to match the confirmed transaction
// against (job ownership, fee, expiry window) — same anti-tampering shape as the course flow.
const createPaddleFeaturedJobCheckout = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) throw new AppError('Paddle checkout is not configured.', 503);
  const { loadFeaturableJob } = require('./job.controller');
  const { job, fee, days } = await loadFeaturableJob(req.params.jobId, req.user._id);

  const transaction = await paddleService.createTransaction({
    title: `Featured job listing — ${job.title}`, amount: fee, currencyCode: 'USD',
    customerEmail: req.user.email,
    metadata: { kind: 'featured_job', jobId: job._id.toString(), purchasedBy: req.user._id.toString() }
  });

  const FeaturedListing = require('../models/FeaturedListing');
  await FeaturedListing.create({
    listingType: 'job', job: job._id, purchasedBy: req.user._id, amount: fee, currency: 'USD',
    paymentMethod: 'paddle', paddleTransactionId: transaction.id, status: 'pending',
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  });

  return ok(res, { transactionId: transaction.id, status: transaction.status });
});

const syncPaddleFeaturedJobStatus = asyncHandler(async (req, res) => {
  const FeaturedListing = require('../models/FeaturedListing');
  const listing = await FeaturedListing.findOne({ job: req.params.jobId, purchasedBy: req.user._id,
    paddleTransactionId: req.params.transactionId });
  if (!listing) throw new AppError('Featured job checkout not found.', 404);
  if (listing.status !== 'paid') {
    const transaction = await paddleService.getTransaction(listing.paddleTransactionId);
    if (transaction.status === 'completed') {
      const { handleFeaturedJobPaddleCompleted } = require('./webhook.controller');
      await handleFeaturedJobPaddleCompleted(transaction);
    }
  }
  const refreshed = await FeaturedListing.findById(listing._id);
  return ok(res, { status: refreshed.status });
});

module.exports = {
  getPaddleConfig, createPaddleTransaction, syncPaddleFeeStatus,
  createWalletTopup, syncWalletTopup, createPaddleCourseCheckout, syncPaddleCourseStatus,
  createPaddleFeaturedJobCheckout, syncPaddleFeaturedJobStatus,
  getNowPaymentsConfig, createCryptoWalletTopup, syncCryptoWalletTopup,
  assertCanPayFee, loadPayableCourse,
  ...require('./stripe.controller')
};
