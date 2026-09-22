const Fee = require('../models/Fee');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const CoursePurchase = require('../models/CoursePurchase');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const paddleService = require('../services/paddle.service');
const env = require('../config/env');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');

// Same authorization as the self-report fee-payment endpoints (student themselves, or any
// approved parent/guardian/sponsor link) — paying a fee doesn't require being a legal guardian.
async function assertCanPayFee(fee, user) {
  if (fee.student.toString() === user._id.toString()) return;
  const link = await ParentChildLink.findOne({ parent: user._id, student: fee.student, status: 'approved' });
  if (!link) throw new AppError('You are not authorized to pay this fee.', 403);
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

const createStripeCourseCheckout = asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) throw new AppError('Stripe checkout is not configured.', 503);
  const { course, amountMinor, currency } = await loadPayableCourse(req.params.courseId, req.user._id);
  const checkout = await getStripeClient().checkout.sessions.create({
    mode: 'payment', payment_method_types: ['card'],
    line_items: [{ price_data: { currency: currency.toLowerCase(), product_data: { name: course.title }, unit_amount: amountMinor }, quantity: 1 }],
    success_url: `${env.clientUrl}/dashboard?courseCheckout=success&courseId=${course._id}`,
    cancel_url: `${env.clientUrl}/dashboard?courseCheckout=cancelled&courseId=${course._id}`,
    metadata: { kind: 'course', courseId: course._id.toString(), studentId: req.user._id.toString() }
  });
  await CoursePurchase.create({ course: course._id, student: req.user._id, provider: 'stripe',
    providerCheckoutId: checkout.id, amountMinor, currency });
  return ok(res, { url: checkout.url, sessionId: checkout.id });
});

const createPaddleCourseCheckout = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) throw new AppError('Paddle checkout is not configured.', 503);
  const { course, amountMinor, currency } = await loadPayableCourse(req.params.courseId, req.user._id);
  const transaction = await paddleService.createTransaction({
    title: course.title, amount: amountMinor / 100, currencyCode: currency,
    customerEmail: req.user.email,
    metadata: { kind: 'course', courseId: course._id.toString(), studentId: req.user._id.toString() }
  });
  await CoursePurchase.create({ course: course._id, student: req.user._id, provider: 'paddle',
    providerCheckoutId: transaction.id, amountMinor, currency });
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

// POST /api/payments/stripe/fees/:feeId/checkout — creates a real Stripe Checkout Session.
// Unlike the self-report payment methods (bank_transfer/cash/mobile_wallet), this fee is NOT
// marked paid here — only Stripe's webhook (payment.webhook.controller.js), after verifying the
// event's signature, can do that. Creating a session just proves intent to pay, not payment.
const createFeeCheckoutSession = asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.', 503);
  }
  const stripe = getStripeClient();

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status === 'paid') throw new AppError('This fee has already been paid.', 400);
  await assertCanPayFee(fee, req.user);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: fee.currency.toLowerCase(),
          product_data: { name: fee.title },
          unit_amount: Math.round(fee.amount * 100)
        },
        quantity: 1
      }
    ],
    success_url: `${env.clientUrl}/dashboard?feePaid=1&feeId=${fee._id}`,
    cancel_url: `${env.clientUrl}/dashboard?feeCancelled=1&feeId=${fee._id}`,
    metadata: { feeId: fee._id.toString(), payerId: req.user._id.toString(), kind: 'fee' }
  });

  fee.status = 'processing';
  fee.stripeSessionId = session.id;
  await fee.save();

  return ok(res, { url: session.url, sessionId: session.id });
});

// GET /api/payments/stripe/config — the frontend needs to know whether card checkout is
// available at all before showing the button (no publishable key leaks anything sensitive).
const getStripeConfig = asyncHandler(async (req, res) => {
  return ok(res, { enabled: isStripeConfigured(), publishableKey: env.stripe.publishableKey || null });
});

// GET /api/payments/paddle/config — frontend needs the client-side token + environment before
// it can load Paddle.js at all (this token is public/safe to expose, same as a Stripe pk_).
const getPaddleConfig = asyncHandler(async (req, res) => {
  return ok(res, {
    enabled: paddleService.isPaddleConfigured(),
    clientToken: env.paddle.clientToken || null,
    environment: env.paddle.environment
  });
});

// POST /api/payments/paddle/fees/:feeId/checkout — creates a real Paddle transaction. Like the
// Stripe flow, the fee is NOT marked paid here — only the Paddle webhook, after verifying its
// signature, does that. Creating a transaction just proves intent to pay.
const createPaddleTransaction = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET.', 503);
  }

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status === 'paid') throw new AppError('This fee has already been paid.', 400);
  await assertCanPayFee(fee, req.user);

  const transaction = await paddleService.createTransaction({
    title: fee.title,
    amount: fee.amount,
    currencyCode: (fee.currency || 'USD').toUpperCase(),
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

  if (fee.status === 'paid') return ok(res, fee);
  if (!fee.paddleTransactionId) throw new AppError('No Paddle transaction found for this fee yet.', 400);

  const transaction = await paddleService.getTransaction(fee.paddleTransactionId);
  if (transaction.status === 'completed') {
    const { handleFeePaddleCompleted } = require('./webhook.controller');
    await handleFeePaddleCompleted(transaction);
  }

  const refreshed = await Fee.findById(fee._id);
  return ok(res, refreshed);
});

// POST /api/payments/paddle/wallet/topup — creates a real Paddle transaction for a wallet
// top-up. Like the fee flow, the wallet is NOT credited here — only the webhook (or sync
// fallback below), after confirming the transaction actually completed, credits it.
const createWalletTopup = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET.', 503);
  }
  const { amount, currency } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);

  const transaction = await paddleService.createTransaction({
    title: `Wallet top-up — ${cur} ${amount}`,
    amount,
    currencyCode: cur,
    customerEmail: req.user.email,
    metadata: { userId: req.user._id.toString(), currency: cur, kind: 'wallet_topup' }
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
  createFeeCheckoutSession, getStripeConfig, getPaddleConfig, createPaddleTransaction, syncPaddleFeeStatus,
  createWalletTopup, syncWalletTopup, createStripeCourseCheckout, createPaddleCourseCheckout, syncPaddleCourseStatus,
  createPaddleFeaturedJobCheckout, syncPaddleFeaturedJobStatus
};
