const AppError = require('../utils/AppError');

// One set of rules for every way an institution fee gets paid online (Paddle, Stripe, JazzCash):
// charge only what is still owed, record each payment as an instalment with its payer, keep
// paid/outstanding/status right, and never silently swallow money that arrives for a fee that
// is already settled (it is recorded and a refund is requested instead).

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const CLOSED = ['paid', 'cancelled', 'waived', 'refunded'];

function outstandingOf(fee) {
  if (fee.status === 'paid') return 0;
  if (fee.outstandingAmount !== undefined && fee.outstandingAmount !== null) return round2(fee.outstandingAmount);
  return round2(Math.max(0, fee.amount - (fee.paidAmount || 0)));
}

// Checks before opening any checkout; returns the amount to charge.
function assertPayableOnline(fee) {
  if (CLOSED.includes(fee.status)) throw new AppError(`This fee is already ${fee.status}.`, 400);
  if ((fee.paymentHistory || []).some((p) => p.verificationStatus === 'pending')) {
    throw new AppError('A payment for this fee is already awaiting the institution’s verification.', 409);
  }
  const amount = outstandingOf(fee);
  if (!(amount > 0)) throw new AppError('Nothing is left to pay on this fee.', 400);
  return amount;
}

// Applies a confirmed online payment. `amount` is in the fee's own currency (what checkout asked
// for). Returns { duplicate } so the caller can pick the right notifications.
function applyOnlinePayment(fee, { amount, method, paidVia, transactionId, payerId }) {
  const value = round2(amount ?? outstandingOf(fee));
  const owed = outstandingOf(fee);
  const entry = { amount: value, method: paidVia || method, transactionId, reference: transactionId, paidOn: new Date(), verificationStatus: 'verified', verifiedAt: new Date(), recordedBy: payerId || null };
  if (CLOSED.includes(fee.status) || owed <= 0) {
    fee.paymentHistory.push({ ...entry, notes: 'Duplicate payment received after the fee was settled — refund due.' });
    if (!fee.refund?.status || ['none', 'rejected'].includes(fee.refund.status)) {
      fee.refund = { ...(fee.refund?.toObject ? fee.refund.toObject() : fee.refund || {}), status: 'requested', amount: value, reason: `Duplicate ${paidVia || method} payment ${transactionId}`, requestedAt: new Date(), duplicate: true };
    }
    return { duplicate: true, amount: value };
  }
  // Someone else paid part of it while this checkout was open: keep what is owed, refund the rest.
  const excess = round2(value - owed);
  if (excess > 0.01 && (!fee.refund?.status || ['none', 'rejected'].includes(fee.refund.status))) {
    fee.refund = { ...(fee.refund?.toObject ? fee.refund.toObject() : fee.refund || {}), status: 'requested', amount: excess, reason: `Overpayment on ${paidVia || method} payment ${transactionId}`, requestedAt: new Date(), duplicate: true };
  }
  fee.paymentHistory.push(entry);
  fee.paidAmount = round2((fee.paidAmount || 0) + Math.min(value, owed));
  fee.outstandingAmount = round2(Math.max(0, fee.amount - fee.paidAmount));
  fee.paymentMethod = method;
  fee.paidVia = paidVia || method;
  fee.transactionId = transactionId;
  fee.paidBy = payerId || fee.paidBy;
  if (fee.outstandingAmount <= 0) {
    fee.status = 'paid';
    fee.paidAt = new Date();
    fee.restrictionActive = false;
  } else {
    fee.status = 'partially_paid';
  }
  return { duplicate: false, amount: value };
}

// A payment that reached a fee nobody owes anymore: the school must refund it and the payer
// should know their money is safe.
async function duplicatePaymentNotifications(fee, { payerId, amount, provider, transactionId }) {
  const Institution = require('../models/Institution');
  const school = await Institution.findById(fee.institution).select('owner');
  const text = `${fee.currency} ${amount} via ${provider} (${transactionId}) arrived after "${fee.title}" was already paid.`;
  return [
    ...(school ? [{ userId: school.owner, payload: { title: `Duplicate fee payment — refund due: ${fee.title}`, body: `${text} A refund request has been opened.`, sentBy: payerId || null } }] : []),
    ...(payerId ? [{ userId: payerId, payload: { title: `Second payment received: ${fee.title}`, body: `${text} The institution has been asked to refund it.`, sentBy: null } }] : [])
  ];
}

module.exports = { outstandingOf, assertPayableOnline, applyOnlinePayment, duplicatePaymentNotifications, round2 };
