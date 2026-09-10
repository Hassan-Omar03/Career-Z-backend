const Commission = require('../models/Commission');
const Withdrawal = require('../models/Withdrawal');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

const COMMISSION_RATE_KEY = 'commission_rate_percent';
const DEFAULT_COMMISSION_RATE = 10;

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
    const t = totalsByCurrency[c.currency] || { earned: 0, pending: 0, available: 0, paid: 0, cancelled: 0 };
    if (c.status !== 'cancelled') t.earned += c.amount;
    if (c.status === 'pending' || c.status === 'approved') t.pending += c.amount;
    if (c.status === 'available') t.available += c.amount;
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
  const { currency } = req.body;
  if (!currency) throw new AppError('currency is required.', 422);

  const available = await Commission.find({ agent: req.user._id, status: 'available', currency });
  if (available.length === 0) throw new AppError('No available commission balance in that currency.', 422);

  const amount = available.reduce((sum, c) => sum + c.amount, 0);
  const withdrawal = await Withdrawal.create({
    agent: req.user._id,
    amount,
    currency,
    commissions: available.map((c) => c._id)
  });

  return created(res, withdrawal, 'Withdrawal requested.');
});

// GET /api/commissions/mine/withdrawals — an agent's own withdrawal history.
const myWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await Withdrawal.find({ agent: req.user._id }).sort({ createdAt: -1 });
  return ok(res, withdrawals);
});

// PATCH /api/commissions/withdrawals/:id/status — admin processes a withdrawal; marking it
// "paid" cascades the linked commissions to "paid" too, so the two ledgers stay consistent.
const updateWithdrawalStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['requested', 'processing', 'paid', 'rejected'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }
  const withdrawal = await Withdrawal.findById(req.params.id);
  if (!withdrawal) throw new AppError('Withdrawal not found.', 404);

  withdrawal.status = status;
  if (status === 'paid') {
    withdrawal.processedAt = new Date();
    await Commission.updateMany({ _id: { $in: withdrawal.commissions } }, { status: 'paid' });
  }
  await withdrawal.save();

  const WITHDRAWAL_NOTIFY_TITLE = {
    requested: `Withdrawal requested: ${withdrawal.currency} ${withdrawal.amount}`,
    processing: `Withdrawal processing: ${withdrawal.currency} ${withdrawal.amount}`,
    paid: `Payment received: ${withdrawal.currency} ${withdrawal.amount}`,
    rejected: `Withdrawal rejected: ${withdrawal.currency} ${withdrawal.amount}`
  };
  await notify(withdrawal.agent, {
    title: WITHDRAWAL_NOTIFY_TITLE[status],
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, withdrawal, 'Withdrawal updated.');
});

module.exports = {
  myCommissions, updateCommissionStatus, requestWithdrawal, myWithdrawals, updateWithdrawalStatus,
  getCommissionRate, setCommissionRate
};
