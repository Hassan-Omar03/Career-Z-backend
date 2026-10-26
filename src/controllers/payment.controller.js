const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const nowPaymentsService = require('../services/nowpayments.service');
const WalletTransaction = require('../models/WalletTransaction');
const env = require('../config/env');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const crypto = require('crypto');

// Online payments: JazzCash (jazzcash.controller.js) for every checkout, plus NOWPayments crypto
// for wallet top-ups. This file keeps the shared payability checks and the crypto flow.

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

// GET /api/payments/nowpayments/config — which crypto currencies are actually available.
const getNowPaymentsConfig = asyncHandler(async (req, res) => {
  return ok(res, { configured: require('../utils/onlinePayments').onlinePaymentsEnabled() && nowPaymentsService.isNowPaymentsConfigured(), currencies: nowPaymentsService.SUPPORTED_CURRENCIES });
});

// POST /api/payments/nowpayments/wallet/topup — creates a real NOWPayments crypto payment
// (USDT TRC20 / BTC / ETH). The wallet is NOT credited here — only the IPN webhook (or the sync
// fallback below), after the crypto network actually confirms, credits it. A pending
// WalletTransaction is created up front so the webhook has something to verify the
// amount/currency/owner against instead of trusting the provider payload blindly.
const createCryptoWalletTopup = asyncHandler(async (req, res) => {
  if (!require('../utils/onlinePayments').onlinePaymentsEnabled()) throw new AppError('Online payment is switched off. Pay by bank transfer and upload the receipts.', 503);
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

module.exports = {
  getNowPaymentsConfig, createCryptoWalletTopup, syncCryptoWalletTopup,
  assertCanPayFee, loadPayableCourse
};
