const mongoose = require('mongoose');
const Commission = require('../models/Commission');
const Withdrawal = require('../models/Withdrawal');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');
const { PAYOUT_METHOD_LABEL } = require('../utils/paymentMethods');

const COMMISSION_RATE_KEY = 'commission_rate_percent';
const DEFAULT_COMMISSION_RATE = 0; // unset = 0 until the Super Admin sets it

// GET /api/commissions/rate — the current platform-wide commission percentage. Any
// authenticated user can read it (it's shown on the Post-a-Job / Commission pages).
const getCommissionRate = asyncHandler(async (req, res) => {
  const setting = await Setting.findOne({ key: COMMISSION_RATE_KEY });
  return ok(res, { rate: setting ? setting.value : DEFAULT_COMMISSION_RATE });
});

// PATCH /api/commissions/rate — Super Admin only. Every new commission (job.controller.js's
// updateApplicationStatus) reads this instead of a hardcoded percentage.
const setCommissionRate = asyncHandler(async (req, res) => {
  const { rate } = req.body;
  if (typeof rate !== 'number' || rate < 0 || rate > 100) throw new AppError('rate must be a number between 0 and 100.', 422);
  const setting = await Setting.findOneAndUpdate(
    { key: COMMISSION_RATE_KEY },
    { key: COMMISSION_RATE_KEY, value: rate },
    { new: true, upsert: true }
  );
  return ok(res, { rate: setting.value }, 'Commission rate updated.');
});

// GET /api/commissions/mine — an agent's own commission ledger + wallet totals.
const myCommissions = asyncHandler(async (req, res) => {
  const commissions = await Commission.find({ agent: req.user._id })
    .populate('job', 'title company')
    .populate('candidate', 'fullName email')
    .sort({ createdAt: -1 });

  // Grouped by currency — summing across different currencies would be a false total.
  const totalsByCurrency = {};
  commissions.forEach((c) => {
    const t = totalsByCurrency[c.currency] || { earned: 0, pending: 0, available: 0, withdrawing: 0, paid: 0, cancelled: 0 };
    if (c.status !== 'cancelled') t.earned += c.amount;
    if (c.status === 'pending' || c.status === 'approved') t.pending += c.amount;
    // Available earnings already in an open withdrawal request are not available again.
    if (c.status === 'available') t[c.withdrawal ? 'withdrawing' : 'available'] += c.amount;
    if (c.status === 'paid') t.paid += c.amount;
    if (c.status === 'cancelled') t.cancelled += c.amount;
    totalsByCurrency[c.currency] = t;
  });

  const hireCount = commissions.filter((c) => c.status !== 'cancelled').length;
  const avgPerHireByCurrency = {};
  Object.entries(totalsByCurrency).forEach(([cur, t]) => {
    const count = commissions.filter((c) => c.currency === cur && c.status !== 'cancelled').length;
    avgPerHireByCurrency[cur] = count > 0 ? Math.round(t.earned / count) : 0;
  });

  return ok(res, { commissions, totalsByCurrency, avgPerHireByCurrency, hireCount });
});

// PATCH /api/commissions/:id/status — admin-only review step (pending -> approved -> available,
// or -> cancelled). This platform has no back-office UI for it yet; useful for testing/ops.
const updateCommissionStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'available', 'paid', 'cancelled'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }
  const commission = await Commission.findById(req.params.id).populate('job', 'title');
  if (!commission) throw new AppError('Commission not found.', 404);
  commission.status = status;
  await commission.save();

  if (status === 'approved') {
    await notify(commission.agent, {
      title: `Commission approved: ${commission.currency} ${commission.amount}`,
      body: commission.job?.title || '',
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, commission, 'Commission updated.');
});

// POST /api/commissions/withdraw — request a withdrawal of all "available" commission in one
// currency. Doesn't move real money (no payment processor in this app) — creates a real,
// trackable request record instead of pretending a payout happened.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { currency, payoutMethod, payoutDetails, accountTitle } = req.body;
  if (!currency) throw new AppError('currency is required.', 422);
  if (!payoutMethod || !PAYOUT_METHOD_LABEL[payoutMethod]) {
    throw new AppError('A valid payoutMethod is required (bank_transfer, mobile_wallet or other).', 422);
  }
  if (!payoutDetails || !payoutDetails.trim()) throw new AppError('payoutDetails (e.g. account number) is required.', 422);
  if (!accountTitle || !accountTitle.trim()) throw new AppError("The account holder's name (accountTitle) is required.", 422);

  if (!Withdrawal.schema.path('payoutMethod').enumValues.includes(payoutMethod)) {
    throw new AppError('Commission payouts go by bank transfer, mobile wallet or other.', 422);
  }

  // Reserve the available commissions for this withdrawal in the same transaction that creates it,
  // so the same earnings can never sit in two withdrawal requests (sequential or parallel).
  const withdrawalId = new mongoose.Types.ObjectId();
  // A findable receipt exists from the moment the request is made, not only once an admin
  // processes it — same reasoning as the main Wallet withdrawal flow.
  const transactionId = generateTransactionId();
  const withdrawal = await mongoose.connection.transaction(async (session) => {
    await Commission.updateMany({ agent: req.user._id, status: 'available', currency, withdrawal: null }, { $set: { withdrawal: withdrawalId } }, { session });
    const reserved = await Commission.find({ withdrawal: withdrawalId }).session(session);
    if (reserved.length === 0) throw new AppError('No available commission balance in that currency.', 422);
    const [row] = await Withdrawal.create([{
      _id: withdrawalId,
      agent: req.user._id,
      amount: reserved.reduce((sum, c) => sum + c.amount, 0),
      currency,
      commissions: reserved.map((c) => c._id),
      payoutMethod,
      payoutDetails: `${accountTitle.trim()} — ${payoutDetails.trim()}`,
      transactionId
    }], { session });
    return row;
  });

  return created(res, withdrawal, `Withdrawal requested — receipt ${transactionId}.`);
});

// GET /api/commissions/mine/withdrawals — an agent's own withdrawal history.
const myWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await Withdrawal.find({ agent: req.user._id }).sort({ createdAt: -1 });
  return ok(res, withdrawals);
});

// PATCH /api/commissions/withdrawals/:id/status — CareerZ finance processes a withdrawal
// (requested -> processing -> paid | rejected; paid and rejected are final). Paid settles the
// reserved commissions; rejected releases them so they can be withdrawn again.
const updateWithdrawalStatus = asyncHandler(async (req, res) => {
  await require('../utils/platformFinance').assertPlatformFinance(req.user);
  const { status } = req.body;
  // The receipt was generated at request time (shown to the agent then) and is kept as is.
  const withdrawal = await require('../utils/payoutStatus').advancePayout(Withdrawal, req.params.id, status,
    status === 'paid' || status === 'rejected' ? { processedAt: new Date() } : {});
  if (status === 'paid') {
    await Commission.updateMany({ _id: { $in: withdrawal.commissions }, withdrawal: withdrawal._id }, { $set: { status: 'paid' } });
  } else if (status === 'rejected') {
    await Commission.updateMany({ _id: { $in: withdrawal.commissions }, withdrawal: withdrawal._id }, { $set: { withdrawal: null } });
  }

  const WITHDRAWAL_NOTIFY_TITLE = {
    requested: `Withdrawal requested: ${withdrawal.currency} ${withdrawal.amount}`,
    processing: `Withdrawal processing: ${withdrawal.currency} ${withdrawal.amount}`,
    paid: `Payout sent: ${withdrawal.currency} ${withdrawal.amount} (receipt ${withdrawal.transactionId})`,
    rejected: `Withdrawal rejected: ${withdrawal.currency} ${withdrawal.amount}`
  };
  await notify(withdrawal.agent, {
    title: WITHDRAWAL_NOTIFY_TITLE[status],
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, withdrawal, 'Withdrawal updated.');
});

// GET /api/commissions/withdrawals/open — CareerZ finance's queue of agent payouts to send.
const openWithdrawals = asyncHandler(async (req, res) => {
  await require('../utils/platformFinance').assertPlatformFinance(req.user);
  const list = await Withdrawal.find({ status: { $in: ['requested', 'processing'] } }).populate('agent', 'fullName email').sort({ createdAt: 1 });
  return ok(res, list);
});

module.exports = {
  myCommissions, updateCommissionStatus, requestWithdrawal, myWithdrawals, updateWithdrawalStatus, openWithdrawals,
  getCommissionRate, setCommissionRate
};
