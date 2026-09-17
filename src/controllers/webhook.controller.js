const Fee = require('../models/Fee');
const Institution = require('../models/Institution');
const WebhookEvent = require('../models/WebhookEvent');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const paddleService = require('../services/paddle.service');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const { notify } = require('../services/notification.service');
const env = require('../config/env');

const FEE_COMMISSION_KEY = 'fee_commission_percent';

// POST /api/webhooks/stripe — mounted in app.js with express.raw() BEFORE the global
// express.json() middleware, because Stripe's signature verification needs the exact raw
// request bytes; a JSON-parsed-and-restringified body will not match the signature.
async function handleStripeWebhook(req, res) {
  if (!isStripeConfigured()) {
    return res.status(503).json({ success: false, message: 'Stripe is not configured.' });
  }
  const stripe = getStripeClient();

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, env.stripe.webhookSecret);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  // Idempotency (spec 3A.3): Stripe retries a webhook delivery on any non-2xx response or
  // timeout. The unique (provider, eventId) index on WebhookEvent is the real guarantee here —
  // a duplicate insert throws E11000, meaning "already processed", so we acknowledge with 200
  // and do nothing further rather than crediting the same payment twice.
  try {
    await WebhookEvent.create({ provider: 'stripe', eventId: event.id, type: event.type });
  } catch (err) {
    if (err.code === 11000) return res.status(200).json({ received: true, duplicate: true });
    throw err;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.metadata?.kind === 'fee') await handleFeeCheckoutCompleted(session);
    }
  } catch (err) {
    // The event is already recorded in WebhookEvent, so Stripe won't get a reason to retry a
    // malformed/unexpected payload forever — log it for manual follow-up instead of 500ing.
    console.error('[stripe webhook] handler error:', err.message);
  }

  return res.status(200).json({ received: true });
}

async function handleFeeCheckoutCompleted(session) {
  const fee = await Fee.findById(session.metadata.feeId);
  if (!fee || fee.status === 'paid') return;

  const receipt = await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY);

  fee.status = 'paid';
  fee.paidAt = new Date();
  fee.paymentMethod = 'stripe';
  fee.paidVia = 'Stripe (Card)';
  fee.transactionId = session.payment_intent || session.id;
  fee.stripePaymentIntentId = session.payment_intent || null;
  fee.paidBy = session.metadata.payerId;
  fee.grossAmount = receipt.grossAmount;
  fee.platformCommission = receipt.platformCommission;
  fee.gatewayCharges = receipt.gatewayCharges;
  fee.taxAmount = receipt.taxAmount;
  fee.netAmount = receipt.netAmount;
  fee.escrowStatus = 'held';
  await fee.save();

  const institution = await Institution.findById(fee.institution);
  if (institution) {
    await notify(institution.owner, {
      title: `Fee paid via Stripe: ${fee.currency} ${fee.amount} — ${fee.title} (receipt ${fee.transactionId})`,
      sentBy: fee.paidBy
    }).catch(() => {});
  }
}

// POST /api/webhooks/paddle — mounted in app.js with express.raw() for the same reason as
// Stripe's: signature verification needs the exact raw request bytes.
async function handlePaddleWebhook(req, res) {
  if (!paddleService.isPaddleConfigured()) {
    return res.status(503).json({ success: false, message: 'Paddle is not configured.' });
  }

  const rawBody = req.body.toString('utf8');
  const signature = req.headers['paddle-signature'];
  if (!paddleService.verifyWebhookSignature(rawBody, signature)) {
    console.error('[paddle webhook] signature verification failed');
    return res.status(400).send('Webhook signature verification failed.');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid JSON payload.');
  }

  // Idempotency — same guarantee as the Stripe handler: a duplicate (provider, eventId) insert
  // throws E11000, meaning "already processed".
  try {
    await WebhookEvent.create({ provider: 'paddle', eventId: event.event_id, type: event.event_type });
  } catch (err) {
    if (err.code === 11000) return res.status(200).json({ received: true, duplicate: true });
    throw err;
  }

  try {
    if (event.event_type === 'transaction.completed') {
      const transaction = event.data;
      if (transaction.custom_data?.kind === 'fee') await handleFeePaddleCompleted(transaction);
    }
  } catch (err) {
    console.error('[paddle webhook] handler error:', err.message);
  }

  return res.status(200).json({ received: true });
}

async function handleFeePaddleCompleted(transaction) {
  const fee = await Fee.findById(transaction.custom_data.feeId);
  if (!fee || fee.status === 'paid') return;

  const receipt = await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY);

  fee.status = 'paid';
  fee.paidAt = new Date();
  fee.paymentMethod = 'paddle';
  fee.paidVia = 'Paddle (Card/Apple Pay/Google Pay)';
  fee.transactionId = transaction.id;
  fee.paddleTransactionId = transaction.id;
  fee.paidBy = transaction.custom_data.payerId;
  fee.grossAmount = receipt.grossAmount;
  fee.platformCommission = receipt.platformCommission;
  fee.gatewayCharges = receipt.gatewayCharges;
  fee.taxAmount = receipt.taxAmount;
  fee.netAmount = receipt.netAmount;
  fee.escrowStatus = 'held';
  fee.receiptNumber = fee.receiptNumber || `RCPT-${Date.now().toString(36).toUpperCase()}-${transaction.id.slice(-6).toUpperCase()}`;
  await fee.save();

  const institution = await Institution.findById(fee.institution);
  if (institution) {
    await notify(institution.owner, {
      title: `Fee paid via Paddle: ${fee.currency} ${fee.amount} — ${fee.title} (receipt ${fee.transactionId})`,
      sentBy: fee.paidBy
    }).catch(() => {});
  }
}

module.exports = { handleStripeWebhook, handlePaddleWebhook, handleFeePaddleCompleted };
