const Fee = require('../models/Fee');
const CoursePurchase = require('../models/CoursePurchase');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const env = require('../config/env');

// payment.controller re-exports these, and they use its helpers — required lazily to avoid a cycle.
const helpers = () => require('./payment.controller');

const createStripeCourseCheckout = asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) throw new AppError('Stripe checkout is not configured.', 503);
  const { course, amountMinor, currency } = await helpers().loadPayableCourse(req.params.courseId, req.user._id);
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

// POST /api/payments/stripe/fees/:feeId/checkout — creates a real Stripe Checkout Session.
// Unlike the self-report payment methods (bank_transfer/cash/mobile_wallet), this fee is NOT
// marked paid here — only Stripe's webhook (webhook.controller.js), after verifying the
// event's signature, can do that. Creating a session just proves intent to pay, not payment.
const createFeeCheckoutSession = asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    throw new AppError('Card payments are not set up yet — ask the Super Admin to configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.', 503);
  }
  const stripe = getStripeClient();

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status === 'paid') throw new AppError('This fee has already been paid.', 400);
  await helpers().assertCanPayFee(fee, req.user);

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
// available at all (no publishable key leaks anything sensitive).
const getStripeConfig = asyncHandler(async (req, res) => {
  return ok(res, { enabled: isStripeConfigured(), publishableKey: env.stripe.publishableKey || null });
});

module.exports = { createStripeCourseCheckout, createFeeCheckoutSession, getStripeConfig };
