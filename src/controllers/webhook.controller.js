const Fee = require('../models/Fee');
const CoursePurchase = require('../models/CoursePurchase');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WebhookEvent = require('../models/WebhookEvent');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const paddleService = require('../services/paddle.service');
const { transactionWithDuplicateRetry, sendSettlementNotifications, settle } = require('../services/settlement.service');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const AppError = require('../utils/AppError');
const env = require('../config/env');

const FEE_COMMISSION_KEY = 'fee_commission_percent';

async function processWebhook(provider, eventId, type, work, res) {
  if (typeof eventId !== 'string' || !eventId || typeof type !== 'string' || !type) {
    return res.status(400).json({ success: false, message: 'Invalid webhook event.' });
  }
  try {
    const result = await transactionWithDuplicateRetry(async (session) => {
      const existing = await WebhookEvent.findOne({ provider, eventId }).session(session);
      if (existing) return { duplicate: true, notifications: [] };
      await WebhookEvent.create([{ provider, eventId, type }], { session });
      const notifications = await work(session);
      return { duplicate: false, notifications };
    });
    await sendSettlementNotifications(result.notifications);
    return res.status(200).json({ received: true, ...(result.duplicate ? { duplicate: true } : {}) });
  } catch (error) {
    // The transaction rolls back both the receipt and all balance changes.
    // A non-2xx response asks the gateway to retry instead of losing the payment.
    console.error(`[${provider} webhook] processing failed:`, error.name);
    return res.status(500).json({ success: false, message: 'Payment processing failed. Please retry.' });
  }
}

async function handleStripeWebhook(req, res) {
  if (!isStripeConfigured()) return res.status(503).json({ success: false, message: 'Stripe is not configured.' });
  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.stripe.webhookSecret);
  } catch {
    return res.status(400).send('Webhook signature verification failed.');
  }
  return processWebhook('stripe', event.id, event.type, async (session) => {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const checkout = event.data.object;
      // Checkout completion may precede payment for delayed payment methods.
      if (checkout.metadata?.kind === 'fee' && checkout.payment_status === 'paid') {
        return handleFeeCheckoutCompleted(checkout, session);
      }
      if (checkout.metadata?.kind === 'course' && checkout.payment_status === 'paid') {
        return handleCourseStripeCompleted(checkout, session);
      }
    }
    return [];
  }, res);
}

async function handleFeeCheckoutCompleted(checkout, session) {
  const fee = await Fee.findById(checkout.metadata.feeId).session(session);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status === 'paid') return [];
  const receipt = await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY);
  Object.assign(fee, receipt, {
    status: 'paid', paidAt: new Date(), paymentMethod: 'stripe', paidVia: 'Stripe (Card)',
    transactionId: checkout.payment_intent || checkout.id, stripePaymentIntentId: checkout.payment_intent || null,
    paidBy: checkout.metadata.payerId, escrowStatus: 'held'
  });
  await fee.save({ session });
  return feeNotification(fee, 'Stripe', session);
}

async function settleCoursePurchase(purchase, paymentId, session) {
  if (purchase.status === 'paid') return [];
  await Enrollment.updateOne(
    { student: purchase.student, course: purchase.course },
    { $setOnInsert: { student: purchase.student, course: purchase.course } },
    { upsert: true, session }
  );
  purchase.status = 'paid';
  purchase.paidAt = new Date();
  purchase.providerPaymentId = paymentId;
  await purchase.save({ session });
  return [{ userId: purchase.student, payload: {
    title: 'Course payment confirmed', body: 'Your course is ready in My Courses.'
  } }];
}

async function handleCourseStripeCompleted(checkout, session) {
  const purchase = await CoursePurchase.findOne({ provider: 'stripe', providerCheckoutId: checkout.id }).session(session);
  if (!purchase) throw new AppError('Course checkout not found.', 404);
  if (checkout.metadata?.courseId !== purchase.course.toString()
    || checkout.metadata?.studentId !== purchase.student.toString()
    || checkout.currency?.toUpperCase() !== purchase.currency
    || checkout.amount_total !== purchase.amountMinor) {
    throw new AppError('Course checkout amount, currency or ownership does not match.', 422);
  }
  return settleCoursePurchase(purchase, checkout.payment_intent || checkout.id, session);
}

async function handleCoursePaddleCompleted(transaction, session) {
  return settle(async (dbSession) => {
    if (transaction.status !== 'completed' || transaction.custom_data?.kind !== 'course') {
      throw new AppError('Expected a completed course payment.', 422);
    }
    const purchase = await CoursePurchase.findOne({ provider: 'paddle', providerCheckoutId: transaction.id }).session(dbSession);
    if (!purchase) throw new AppError('Course checkout not found.', 404);
    const price = transaction.items?.[0]?.price?.unit_price;
    if (transaction.custom_data.courseId !== purchase.course.toString()
      || transaction.custom_data.studentId !== purchase.student.toString()
      || transaction.currency_code !== purchase.currency
      || transaction.items?.length !== 1 || transaction.items[0].quantity !== 1
      || Number(price?.amount) !== purchase.amountMinor || price?.currency_code !== purchase.currency) {
      throw new AppError('Course transaction amount, currency or ownership does not match.', 422);
    }
    return settleCoursePurchase(purchase, transaction.id, dbSession);
  }, session);
}

async function handlePaddleWebhook(req, res) {
  if (!paddleService.isPaddleConfigured()) return res.status(503).json({ success: false, message: 'Paddle is not configured.' });
  const rawBody = req.body.toString('utf8');
  if (!paddleService.verifyWebhookSignature(rawBody, req.headers['paddle-signature'])) {
    return res.status(400).send('Webhook signature verification failed.');
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).send('Invalid JSON payload.'); }
  return processWebhook('paddle', event?.event_id, event?.event_type, async (session) => {
    if (event.event_type === 'transaction.completed') {
      const transaction = event.data;
      if (transaction.custom_data?.kind === 'fee') return handleFeePaddleCompleted(transaction, session);
      if (transaction.custom_data?.kind === 'wallet_topup') return handleWalletTopupCompleted(transaction, session);
      if (transaction.custom_data?.kind === 'course') return handleCoursePaddleCompleted(transaction, session);
      if (transaction.custom_data?.kind === 'featured_job') return handleFeaturedJobPaddleCompleted(transaction, session);
      if (transaction.custom_data?.kind === 'subscription') return handleSubscriptionPaddleCompleted(transaction, session);
    }
    return [];
  }, res);
}

async function feeNotification(fee, provider, session) {
  const institution = await Institution.findById(fee.institution).session(session);
  return institution ? [{
    userId: institution.owner,
    payload: { title: `Fee paid via ${provider}: ${fee.currency} ${fee.amount} — ${fee.title} (receipt ${fee.transactionId})`, sentBy: fee.paidBy }
  }] : [];
}

async function handleFeePaddleCompleted(transaction, session) {
  return settle(async (dbSession) => {
    if (transaction.status !== 'completed' || transaction.custom_data?.kind !== 'fee') {
      throw new AppError('Expected a completed fee payment.', 422);
    }
    const fee = await Fee.findById(transaction.custom_data.feeId).session(dbSession);
    if (!fee) throw new AppError('Fee record not found.', 404);
    if (fee.status === 'paid') return [];
    const receipt = await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY);
    Object.assign(fee, receipt, {
      status: 'paid', paidAt: new Date(), paymentMethod: 'paddle', paidVia: 'Paddle (Card/Apple Pay/Google Pay)',
      transactionId: transaction.id, paddleTransactionId: transaction.id, paidBy: transaction.custom_data.payerId,
      escrowStatus: 'held',
      receiptNumber: fee.receiptNumber || `RCPT-${Date.now().toString(36).toUpperCase()}-${transaction.id.slice(-6).toUpperCase()}`
    });
    await fee.save({ session: dbSession });
    return feeNotification(fee, 'Paddle', dbSession);
  }, session);
}

async function handleWalletTopupCompleted(transaction, session) {
  return settle(async (dbSession) => {
    if (transaction.status !== 'completed' || transaction.custom_data?.kind !== 'wallet_topup' || !transaction.id) {
      throw new AppError('Expected a completed wallet top-up.', 422);
    }
    const already = await WalletTransaction.findOne({ paddleTransactionId: transaction.id }).session(dbSession);
    if (already) return [];
    const { userId } = transaction.custom_data;
    const currency = normalizeCurrency(transaction.custom_data.currency);
    const price = transaction.items?.[0]?.price?.unit_price;
    // Top-ups created by this API contain exactly one unit. Never credit tax as wallet funds.
    const minorAmount = Number(price?.amount);
    if (transaction.items?.length !== 1 || transaction.items[0].quantity !== 1 ||
        !Number.isSafeInteger(minorAmount) || minorAmount <= 0 ||
        price.currency_code !== currency || transaction.currency_code !== currency) {
      throw new AppError('Invalid wallet top-up amount or currency.', 422);
    }
    const amount = validateAmount(minorAmount / 100);
    await WalletTransaction.create([{
      user: userId, type: 'topup', amount, currency, status: 'completed', paddleTransactionId: transaction.id
    }], { session: dbSession });
    await Wallet.findOneAndUpdate(
      { user: userId, currency }, { $inc: { available: amount } }, { upsert: true, session: dbSession }
    );
    return [{ userId, payload: { title: `Wallet topped up: ${currency} ${amount.toFixed(2)}`, body: `Receipt ${transaction.id}`, sentBy: null } }];
  }, session);
}

async function handleFeaturedJobPaddleCompleted(transaction, session) {
  return settle(async (dbSession) => {
    if (transaction.status !== 'completed' || transaction.custom_data?.kind !== 'featured_job') {
      throw new AppError('Expected a completed featured-job payment.', 422);
    }
    const FeaturedListing = require('../models/FeaturedListing');
    const Job = require('../models/Job');
    const listing = await FeaturedListing.findOne({ paddleTransactionId: transaction.id }).session(dbSession);
    if (!listing) throw new AppError('Featured job checkout not found.', 404);
    if (listing.status === 'paid') return [];

    if (transaction.custom_data.jobId !== listing.job.toString()
      || transaction.custom_data.purchasedBy !== listing.purchasedBy.toString()
      || transaction.currency_code !== listing.currency) {
      throw new AppError('Featured job transaction amount, currency or ownership does not match.', 422);
    }
    const price = transaction.items?.[0]?.price?.unit_price;
    if (Number(price?.amount) !== Math.round(listing.amount * 100) || price?.currency_code !== listing.currency) {
      throw new AppError('Featured job transaction amount does not match the recorded fee.', 422);
    }

    listing.status = 'paid';
    listing.transactionId = transaction.id;
    await listing.save({ session: dbSession });

    const job = await Job.findById(listing.job).session(dbSession);
    if (job) {
      job.featured = true;
      job.featuredUntil = listing.expiresAt;
      await job.save({ session: dbSession });
    }

    return [{ userId: listing.purchasedBy, payload: {
      title: `Job featured: ${job?.title || 'Your listing'}`, body: `Receipt ${transaction.id}`, sentBy: null
    } }];
  }, session);
}

async function handleSubscriptionPaddleCompleted(transaction, session) {
  return settle(async (dbSession) => {
    if (transaction.status !== 'completed' || transaction.custom_data?.kind !== 'subscription') {
      throw new AppError('Expected a completed subscription payment.', 422);
    }
    const SubscriptionPurchase = require('../models/SubscriptionPurchase');
    const purchase = await SubscriptionPurchase.findOne({ paddleTransactionId: transaction.id }).session(dbSession);
    if (!purchase) throw new AppError('Subscription checkout not found.', 404);
    if (purchase.status === 'paid') return [];

    if (transaction.custom_data.institutionId !== purchase.institution.toString()
      || transaction.custom_data.plan !== purchase.plan
      || transaction.custom_data.purchasedBy !== purchase.purchasedBy.toString()
      || transaction.currency_code !== purchase.currency) {
      throw new AppError('Subscription transaction plan, currency or ownership does not match.', 422);
    }
    const price = transaction.items?.[0]?.price?.unit_price;
    if (Number(price?.amount) !== Math.round(purchase.amount * 100) || price?.currency_code !== purchase.currency) {
      throw new AppError('Subscription transaction amount does not match the recorded price.', 422);
    }

    purchase.status = 'paid';
    await purchase.save({ session: dbSession });

    const institution = await Institution.findById(purchase.institution).session(dbSession);
    if (!institution) throw new AppError('Institution not found.', 404);
    // Stacks onto a still-active period of the SAME plan; otherwise (new plan, or lapsed) starts
    // a fresh 30-day period from now.
    const sameActivePlan = institution.subscription?.plan === purchase.plan
      && institution.subscription?.status === 'active'
      && institution.subscription?.currentPeriodEnd
      && new Date(institution.subscription.currentPeriodEnd) > new Date();
    const base = sameActivePlan ? new Date(institution.subscription.currentPeriodEnd) : new Date();
    institution.subscription = {
      plan: purchase.plan, status: 'active',
      currentPeriodEnd: new Date(base.getTime() + purchase.periodDays * 24 * 60 * 60 * 1000),
      paddleTransactionId: transaction.id
    };
    await institution.save({ session: dbSession });

    return [{ userId: purchase.purchasedBy, payload: {
      title: `Subscription activated: ${purchase.plan} plan`,
      body: `${institution.name} is now on the ${purchase.plan} plan until ${institution.subscription.currentPeriodEnd.toDateString()}. Receipt ${transaction.id}`,
      sentBy: null
    } }];
  }, session);
}

module.exports = {
  handleStripeWebhook, handlePaddleWebhook, handleFeePaddleCompleted, handleWalletTopupCompleted,
  handleCoursePaddleCompleted, handleFeaturedJobPaddleCompleted, handleSubscriptionPaddleCompleted
};
