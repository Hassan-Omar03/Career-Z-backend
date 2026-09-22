const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const { notify, notifyAdmins } = require('../services/notification.service');

const getMyWallet = asyncHandler(async (req, res) => {
  const currency = normalizeCurrency(req.query.currency);
  const wallet = await Wallet.findOne({ user: req.user._id, currency });
  const transactions = await WalletTransaction.find({ user: req.user._id, currency }).sort({ createdAt: -1 }).limit(50);
  return ok(res, { currency, available: wallet?.available || 0, pending: wallet?.pending || 0, transactions });
});

// Reserve funds and create the withdrawal record in the same transaction.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, currency, payoutMethod, payoutDetails } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  if (typeof payoutMethod !== 'string' || !payoutMethod.trim() || typeof payoutDetails !== 'string' || !payoutDetails.trim()) {
    throw new AppError('payoutMethod and payoutDetails are required.', 422);
  }
  const tx = await mongoose.connection.transaction(async (session) => {
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id, currency: cur, available: { $gte: amount } },
      { $inc: { available: -amount, pending: amount } },
      { new: true, session }
    );
    if (!wallet) throw new AppError('Insufficient available balance.', 422);
    const [entry] = await WalletTransaction.create([{
      user: req.user._id, type: 'withdrawal', amount, currency: cur, status: 'pending', payoutMethod, payoutDetails
    }], { session });
    return entry;
  });
  await notifyAdmins({
    title: `New wallet withdrawal request: ${cur} ${amount}`,
    body: `${req.user.fullName} (${req.user.email}) requested a withdrawal via ${payoutMethod}.`
  }).catch(() => {});
  return ok(res, tx, 'Withdrawal requested — pending Admin review.');
});

const listPendingWithdrawals = asyncHandler(async (req, res) => {
  const list = await WalletTransaction.find({ type: 'withdrawal', status: 'pending' }).populate('user', 'fullName email').sort({ createdAt: 1 });
  return ok(res, list);
});

// Approval records an off-platform payout; rejection returns the reserved funds.
const reviewWithdrawal = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);
  const tx = await mongoose.connection.transaction(async (session) => {
    const entry = await WalletTransaction.findById(req.params.id).session(session);
    if (!entry || entry.type !== 'withdrawal') throw new AppError('Withdrawal request not found.', 404);
    if (entry.status !== 'pending') throw new AppError('This request has already been reviewed.', 400);
    validateAmount(entry.amount);
    const wallet = await Wallet.findOneAndUpdate(
      { user: entry.user, currency: entry.currency, pending: { $gte: entry.amount } },
      { $inc: { pending: -entry.amount, available: decision === 'rejected' ? entry.amount : 0 } },
      { new: true, session }
    );
    if (!wallet) throw new AppError('Reserved withdrawal funds are unavailable. Review the wallet ledger.', 409);
    entry.status = decision === 'approved' ? 'completed' : 'rejected';
    entry.processedBy = req.user._id;
    entry.processedAt = new Date();
    await entry.save({ session });
    return entry;
  });
  // Notifications cannot turn a committed payout into an API failure.
  await (async () => {
    const user = await User.findById(tx.user).select('email');
    await notify(tx.user, {
      title: `Withdrawal ${decision}: ${tx.currency} ${tx.amount}`,
      body: decision === 'approved' ? `Sent via ${tx.payoutMethod} — ${tx.payoutDetails}` : 'Funds returned to your available balance.',
      sentBy: req.user._id
    }, { email: true, toAddress: user?.email });
  })().catch(() => {});
  return ok(res, tx, `Withdrawal ${decision}.`);
});

const transfer = asyncHandler(async (req, res) => {
  const { recipientEmail, amount, currency, note } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  if (typeof recipientEmail !== 'string' || !recipientEmail.trim()) throw new AppError('recipientEmail is required.', 422);
  const recipient = await User.findOne({ email: recipientEmail.toLowerCase().trim() });
  if (!recipient) throw new AppError('No user found with that email.', 404);
  if (recipient._id.equals(req.user._id)) throw new AppError('You cannot transfer to yourself.', 422);
  const balances = await mongoose.connection.transaction(async (session) => {
    const senderWallet = await Wallet.findOneAndUpdate(
      { user: req.user._id, currency: cur, available: { $gte: amount } },
      { $inc: { available: -amount } },
      { new: true, session }
    );
    if (!senderWallet) throw new AppError('Insufficient available balance.', 422);
    const recipientWallet = await Wallet.findOneAndUpdate(
      { user: recipient._id, currency: cur },
      { $inc: { available: amount } },
      { upsert: true, new: true, session }
    );
    // Operations sharing a transaction session must run sequentially.
    await WalletTransaction.create([{
      user: req.user._id, type: 'transfer_out', amount, currency: cur, counterparty: recipient._id, note: note || ''
    }], { session });
    await WalletTransaction.create([{
      user: recipient._id, type: 'transfer_in', amount, currency: cur, counterparty: req.user._id, note: note || ''
    }], { session });
    return { senderAvailable: senderWallet.available, recipientAvailable: recipientWallet.available };
  });
  await notify(recipient._id, {
    title: `You received ${cur} ${amount} from ${req.user.fullName}`, body: note || '', sentBy: req.user._id
  }).catch(() => {});
  return ok(res, balances, 'Transfer complete.');
});

module.exports = { getMyWallet, requestWithdrawal, listPendingWithdrawals, reviewWithdrawal, transfer };
