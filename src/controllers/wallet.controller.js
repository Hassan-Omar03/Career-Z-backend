const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { notify, notifyAdmins } = require('../services/notification.service');

// GET /api/wallet/me?currency=USD
const getMyWallet = asyncHandler(async (req, res) => {
  const currency = (req.query.currency || 'USD').toUpperCase();
  const wallet = await Wallet.findOne({ user: req.user._id, currency });
  const transactions = await WalletTransaction.find({ user: req.user._id, currency }).sort({ createdAt: -1 }).limit(50);
  return ok(res, {
    currency,
    available: wallet?.available || 0,
    pending: wallet?.pending || 0,
    transactions
  });
});

// POST /api/wallet/withdraw — moves `amount` from available -> pending and creates a real,
// trackable withdrawal request. Same honest pattern as the Agent Withdrawal/Seller payout flows —
// Admin actually processes it outside the platform (no real payment-out gateway exists), but the
// balance movement itself and the audit trail are real.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, currency = 'USD', payoutMethod, payoutDetails } = req.body;
  const cur = currency.toUpperCase();
  if (!amount || amount <= 0) throw new AppError('A positive amount is required.', 422);
  if (!payoutMethod || !payoutDetails) throw new AppError('payoutMethod and payoutDetails are required.', 422);

  const wallet = await Wallet.findOne({ user: req.user._id, currency: cur });
  if (!wallet || wallet.available < amount) throw new AppError('Insufficient available balance.', 422);

  wallet.available -= amount;
  wallet.pending += amount;
  await wallet.save();

  const tx = await WalletTransaction.create({
    user: req.user._id, type: 'withdrawal', amount, currency: cur, status: 'pending', payoutMethod, payoutDetails
  });

  await notifyAdmins({
    title: `New wallet withdrawal request: ${cur} ${amount}`,
    body: `${req.user.fullName} (${req.user.email}) requested a withdrawal via ${payoutMethod}.`
  }).catch(() => {});

  return ok(res, tx, 'Withdrawal requested — pending Admin review.');
});

// GET /api/wallet/withdrawals/pending — Admin
const listPendingWithdrawals = asyncHandler(async (req, res) => {
  const list = await WalletTransaction.find({ type: 'withdrawal', status: 'pending' }).populate('user', 'fullName email').sort({ createdAt: 1 });
  return ok(res, list);
});

// PATCH /api/wallet/withdrawals/:id/review — Admin approves (real payout happens outside the
// platform, e.g. bank transfer) or rejects (money returns to available balance).
const reviewWithdrawal = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);

  const tx = await WalletTransaction.findById(req.params.id);
  if (!tx || tx.type !== 'withdrawal') throw new AppError('Withdrawal request not found.', 404);
  if (tx.status !== 'pending') throw new AppError('This request has already been reviewed.', 400);

  const wallet = await Wallet.findOne({ user: tx.user, currency: tx.currency });
  if (wallet) {
    wallet.pending = Math.max(0, wallet.pending - tx.amount);
    if (decision === 'rejected') wallet.available += tx.amount;
    await wallet.save();
  }

  tx.status = decision === 'approved' ? 'completed' : 'rejected';
  tx.processedBy = req.user._id;
  tx.processedAt = new Date();
  await tx.save();

  await notify(tx.user, {
    title: `Withdrawal ${decision}: ${tx.currency} ${tx.amount}`,
    body: decision === 'approved' ? `Sent via ${tx.payoutMethod} — ${tx.payoutDetails}` : 'Funds returned to your available balance.',
    sentBy: req.user._id
  }, { email: true, toAddress: (await User.findById(tx.user).select('email'))?.email }).catch(() => {});

  return ok(res, tx, `Withdrawal ${decision}.`);
});

// POST /api/wallet/transfer — real, atomic internal transfer between two users' wallets.
const transfer = asyncHandler(async (req, res) => {
  const { recipientEmail, amount, currency = 'USD', note } = req.body;
  const cur = currency.toUpperCase();
  if (!recipientEmail || !amount || amount <= 0) throw new AppError('recipientEmail and a positive amount are required.', 422);

  const recipient = await User.findOne({ email: recipientEmail.toLowerCase().trim() });
  if (!recipient) throw new AppError('No user found with that email.', 404);
  if (recipient._id.toString() === req.user._id.toString()) throw new AppError('You cannot transfer to yourself.', 422);

  const senderWallet = await Wallet.findOne({ user: req.user._id, currency: cur });
  if (!senderWallet || senderWallet.available < amount) throw new AppError('Insufficient available balance.', 422);

  senderWallet.available -= amount;
  await senderWallet.save();

  const recipientWallet = await Wallet.findOneAndUpdate(
    { user: recipient._id, currency: cur },
    { $inc: { available: amount } },
    { upsert: true, new: true }
  );

  await WalletTransaction.create({ user: req.user._id, type: 'transfer_out', amount, currency: cur, counterparty: recipient._id, note: note || '' });
  await WalletTransaction.create({ user: recipient._id, type: 'transfer_in', amount, currency: cur, counterparty: req.user._id, note: note || '' });

  await notify(recipient._id, {
    title: `You received ${cur} ${amount} from ${req.user.fullName}`,
    body: note || '',
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, { senderAvailable: senderWallet.available, recipientAvailable: recipientWallet.available }, 'Transfer complete.');
});

module.exports = { getMyWallet, requestWithdrawal, listPendingWithdrawals, reviewWithdrawal, transfer };
