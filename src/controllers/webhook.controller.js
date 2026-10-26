const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WebhookEvent = require('../models/WebhookEvent');
const nowPaymentsService = require('../services/nowpayments.service');
const { transactionWithDuplicateRetry, sendSettlementNotifications, settle } = require('../services/settlement.service');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const AppError = require('../utils/AppError');

const FEE_COMMISSION_KEY = 'fee_commission_percent';

// Settlement shared by every gateway (JazzCash today, NOWPayments for crypto top-ups). Each
// settle* function applies a confirmed payment to OUR stored record exactly once — amounts and
// ownership always come from that record, never from the gateway payload.

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
  // The course's institute (else its teacher) is paid now, less CareerZ's course commission.
  const course = await require('../models/Course').findById(purchase.course).select('title teacher institution').session(session);
  const institution = course?.institution ? await Institution.findById(course.institution).select('owner').session(session) : null;
  await require('../services/feeWalletSettlement.service').creditEarner({
    recipient: institution?.owner || course?.teacher, amount: purchase.amountMinor / 100, currency: purchase.currency,
    reference: `CRS-${paymentId}`, payerId: purchase.student, note: `Course sale: ${course?.title || 'course'}`, commissionKey: 'course_commission_percent'
  }, session);
  return [{ userId: purchase.student, payload: {
    title: 'Course payment confirmed', body: 'Your course is ready in My Courses.'
  } }];
}

// The institution, the student and every approved parent hear about an online fee payment, with
// who paid it; the payer gets a confirmation instead.
// Apply the payment (instalment + payer + status), issue the receipt once fully paid, and pick
// the right notifications (normal or duplicate).
async function settleOnlineFee(fee, { amount, method, paidVia, transactionId, payerId, extra = {} }, provider, session) {
  const settlement = require('../services/feeSettlement.service');
  const owedBefore = settlement.outstandingOf(fee);
  const result = settlement.applyOnlinePayment(fee, { amount, method, paidVia, transactionId, payerId });
  Object.assign(fee, extra);
  // The gateway already confirmed the money, so it is not held: the institute's share goes to its
  // wallet now and CareerZ keeps its commission. A duplicate payment is refunded, never credited.
  if (!result.duplicate) {
    await require('../services/feeWalletSettlement.service').creditInstitution(fee, { amount: Math.min(result.amount, owedBefore), reference: `GW-${transactionId}`, payerId }, session);
  }
  if (!result.duplicate && fee.status === 'paid') {
    Object.assign(fee, await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY), { escrowStatus: 'released', escrowReleasedAt: new Date() });
    fee.receiptNumber = fee.receiptNumber || `RCPT-${Date.now().toString(36).toUpperCase()}-${String(transactionId).slice(-6).toUpperCase()}`;
  }
  await fee.save({ session });
  if (result.duplicate) return settlement.duplicatePaymentNotifications(fee, { payerId, amount: result.amount, provider, transactionId });
  return feeNotification(fee, provider, session, result.amount);
}

async function feeNotification(fee, provider, session, amountPaid) {
  const institution = await Institution.findById(fee.institution).session(session);
  return require('../services/feePayer.service').paidNotifications({
    studentId: fee.student, payerId: fee.paidBy, what: fee.title,
    amountText: `${fee.currency} ${amountPaid ?? fee.amount} via ${provider}${fee.status === 'partially_paid' ? ` (remaining ${fee.currency} ${fee.outstandingAmount})` : ''}`, receipt: fee.receiptNumber || fee.transactionId,
    others: [institution?.owner]
  });
}

// NOWPayments statuses: waiting -> confirming -> confirmed -> finished (settled), or
// failed/expired/refunded. Only finished credits the wallet.
async function handleNowPaymentsCompleted(payment, session) {
  return settle(async (dbSession) => {
    if (!(payment.payment_status === 'finished') || !payment.payment_id) {
      throw new AppError('Expected a finished crypto payment.', 422);
    }
    const pending = await WalletTransaction.findOne({ nowPaymentsId: String(payment.payment_id) }).session(dbSession);
    if (!pending) throw new AppError('Crypto top-up record not found.', 404);
    if (pending.status === 'completed') return [];
    if (pending.gatewayOrderId && (payment.order_id !== pending.gatewayOrderId
      || Number(payment.price_amount) !== pending.gatewayPriceAmount
      || String(payment.price_currency).toLowerCase() !== pending.gatewayPriceCurrency
      || payment.pay_currency !== pending.gatewayPayCurrency
      || !Number.isFinite(Number(payment.actually_paid))
      || Number(payment.actually_paid) + 1e-8 < pending.gatewayPayAmount)) {
      throw new AppError('Crypto payment amount, currency or order does not match checkout.', 422);
    }

    pending.status = 'completed';
    await pending.save({ session: dbSession });
    await Wallet.findOneAndUpdate(
      { user: pending.user, currency: pending.currency }, { $inc: { available: pending.amount } },
      { upsert: true, session: dbSession }
    );
    return [{ userId: pending.user, payload: { title: `Wallet topped up: ${pending.currency} ${pending.amount.toFixed(2)}`, body: `Crypto receipt ${payment.payment_id}`, sentBy: null } }];
  }, session);
}

async function handleNowPaymentsWebhook(req, res) {
  if (!nowPaymentsService.isNowPaymentsConfigured()) return res.status(503).json({ success: false, message: 'Crypto payments are not configured.' });
  if (!nowPaymentsService.verifyIpnSignature(req.body, req.headers['x-nowpayments-sig'])) {
    return res.status(400).json({ success: false, message: 'IPN signature verification failed.' });
  }
  const payment = req.body;
  // NOWPayments re-sends an IPN for every status transition of the same payment_id (waiting ->
  // confirming -> finished) — keying the dedupe receipt on id+status alone (not just id) so the
  // eventual "finished" call is never swallowed as a duplicate of an earlier "waiting" one.
  return processWebhook('nowpayments', `${payment.payment_id}:${payment.payment_status}`, payment.payment_status, async (session) => {
    if ((payment.payment_status === 'finished')) return handleNowPaymentsCompleted(payment, session);
    return [];
  }, res);
}

// A confirmed featured-job purchase: mark the listing paid and feature the job until expiry.
async function settleFeaturedListing(listing, receiptId, session) {
  if (listing.status === 'paid') return [];
  const Job = require('../models/Job');
  listing.status = 'paid';
  listing.transactionId = receiptId;
  await listing.save({ session });

  const job = await Job.findById(listing.job).session(session);
  if (job) {
    job.featured = true;
    job.featuredUntil = listing.expiresAt;
    await job.save({ session });
  }

  return [{ userId: listing.purchasedBy, payload: {
    title: `Job featured: ${job?.title || 'Your listing'}`, body: `Receipt ${receiptId}`, sentBy: null
  } }];
}

// A confirmed plan purchase: activate the plan. Stacks onto a still-active period of the SAME
// plan; otherwise (new plan, or lapsed) starts a fresh period from now.
async function settleSubscriptionPurchase(purchase, receiptId, session) {
  if (purchase.status === 'paid') return [];
  purchase.status = 'paid';
  await purchase.save({ session });

  const institution = await Institution.findById(purchase.institution).session(session);
  if (!institution) throw new AppError('Institution not found.', 404);
  const sameActivePlan = institution.subscription?.plan === purchase.plan
    && institution.subscription?.status === 'active'
    && institution.subscription?.currentPeriodEnd
    && new Date(institution.subscription.currentPeriodEnd) > new Date();
  const base = sameActivePlan ? new Date(institution.subscription.currentPeriodEnd) : new Date();
  institution.subscription = {
    plan: purchase.plan, status: 'active',
    currentPeriodEnd: new Date(base.getTime() + purchase.periodDays * 24 * 60 * 60 * 1000)
  };
  await institution.save({ session });

  return [{ userId: purchase.purchasedBy, payload: {
    title: `Subscription activated: ${purchase.plan} plan`,
    body: `${institution.name} is now on the ${purchase.plan} plan until ${institution.subscription.currentPeriodEnd.toDateString()}. Receipt ${receiptId}`,
    sentBy: null
  } }];
}

// A confirmed tuition payment. If the fee was already paid (student and parent paid at once),
// the second payment is recorded and the teacher is asked to refund it.
async function settleTutoringFee(link, { receiptId, payerId, amount, currency }, session) {
  if (link.feeReceipt === receiptId || (link.extraPayments || []).some((p) => p.transactionId === receiptId)) return [];
  payerId = payerId || link.student;
  if (link.feePaidAt) {
    link.extraPayments.push({ transactionId: receiptId, payer: payerId, amount, currency, at: new Date() });
    await link.save({ session });
    const text = `${currency} ${amount} (${receiptId}) arrived after this tuition fee was already paid.`;
    return [
      { userId: link.teacher, payload: { title: 'Duplicate tuition payment — please refund', body: text, sentBy: payerId } },
      { userId: payerId, payload: { title: 'Second tuition payment received', body: `${text} Your tutor has been asked to refund it.`, sentBy: null } }
    ];
  }

  // The payer is the student or one of their approved guardians (checked at checkout).
  const payer = await require('../services/feePayer.service').payerInfo(payerId, link.student);
  link.feePaidAt = new Date();
  link.feePaidBy = payerId;
  link.feePaidByRole = payer?.role || 'Student';
  link.feeReceipt = receiptId;
  await link.save({ session });
  // The tutor is paid now, less CareerZ's tutoring commission.
  await require('../services/feeWalletSettlement.service').creditEarner({
    recipient: link.teacher, amount, currency, reference: `TUT-${receiptId}`, payerId, note: 'Tuition fee', commissionKey: 'tutoring_commission_percent'
  }, session);

  return require('../services/feePayer.service').paidNotifications({
    studentId: link.student, payerId, what: 'Tuition fee', amountText: `${link.feeCurrency} ${link.feeAmount}`,
    receipt: receiptId, others: [link.teacher]
  });
}

module.exports = {
  handleNowPaymentsWebhook, handleNowPaymentsCompleted,
  feeNotification, settleCoursePurchase, settleOnlineFee,
  settleFeaturedListing, settleSubscriptionPurchase, settleTutoringFee
};
