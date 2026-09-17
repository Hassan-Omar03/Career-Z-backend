const Fee = require('../models/Fee');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const paddleService = require('../services/paddle.service');
const env = require('../config/env');

// Same authorization as the self-report fee-payment endpoints (student themselves, or any
// approved parent/guardian/sponsor link) — paying a fee doesn't require being a legal guardian.
async function assertCanPayFee(fee, user) {
  if (fee.student.toString() === user._id.toString()) return;
  const link = await ParentChildLink.findOne({ parent: user._id, student: fee.student, status: 'approved' });
  if (!link) throw new AppError('You are not authorized to pay this fee.', 403);
}

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

module.exports = { createFeeCheckoutSession, getStripeConfig, getPaddleConfig, createPaddleTransaction, syncPaddleFeeStatus };
