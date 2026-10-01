const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { validateAmount, normalizeCurrency } = require('../utils/walletInput');
const { notify, notifyAdmins } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');

const getMyWallet = asyncHandler(async (req, res) => {
  const currency = normalizeCurrency(req.query.currency);
  const wallet = await Wallet.findOne({ user: req.user._id, currency });
  const transactions = await WalletTransaction.find({ user: req.user._id, currency }).sort({ createdAt: -1 }).limit(50);
  return ok(res, { currency, available: wallet?.available || 0, pending: wallet?.pending || 0, transactions });
});

// Reserve funds and create the withdrawal record in the same transaction. A findable receipt
// (`reference`) is generated right here, at request time — not only once Admin approves it — so
// the requester always has proof a request exists, even if it's later rejected or never actioned.
// `accountTitle` (the name on the account) is required too: no real bank-verification API is
// connected here, so this is the honest substitute — it's entered explicitly by the requester and
// shown back to Admin on the review screen, rather than silently trusting a bare account number.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, currency, payoutMethod, payoutDetails, accountTitle } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  if (typeof payoutMethod !== 'string' || !payoutMethod.trim() || typeof payoutDetails !== 'string' || !payoutDetails.trim()) {
    throw new AppError('payoutMethod and payoutDetails are required.', 422);
  }
  if (typeof accountTitle !== 'string' || !accountTitle.trim()) {
    throw new AppError("The account holder's name (accountTitle) is required.", 422);
  }
  const reference = generateTransactionId();
  const tx = await mongoose.connection.transaction(async (session) => {
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id, currency: cur, available: { $gte: amount } },
      { $inc: { available: -amount, pending: amount } },
      { new: true, session }
    );
    if (!wallet) throw new AppError('Insufficient available balance.', 422);
    const [entry] = await WalletTransaction.create([{
      user: req.user._id, type: 'withdrawal', amount, currency: cur, status: 'pending', payoutMethod,
      payoutDetails: `${accountTitle.trim()} — ${payoutDetails.trim()}`, reference
    }], { session });
    return entry;
  });
  await notifyAdmins({
    title: `New wallet withdrawal request: ${cur} ${amount}`,
    body: `${req.user.fullName} (${req.user.email}) requested a withdrawal via ${payoutMethod} to ${accountTitle.trim()} — receipt ${reference}.`
  }).catch(() => {});
  return ok(res, { ...tx.toObject(), id: tx.id, reference }, `Withdrawal requested — receipt ${reference}, pending Admin review.`);
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

// Two safety guarantees for any wallet-to-wallet move (this function and markPayslipPaid's
// platform_wallet branch both follow this shape):
// 1. The recipient is resolved and verified to be a REAL, existing account BEFORE any balance is
//    touched — if they don't exist, the request fails at that check and zero money has moved yet
//    (there is nothing to "reverse" because nothing was ever deducted).
// 2. Both legs (sender debit + recipient credit) happen inside one MongoDB transaction — if
//    anything fails partway through (recipient wallet write, ledger write, anything), the entire
//    transaction is rolled back atomically and the sender's balance is exactly as it was before.
const transfer = asyncHandler(async (req, res) => {
  const { recipientEmail, amount, currency, note } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  if (typeof recipientEmail !== 'string' || !recipientEmail.trim()) throw new AppError('recipientEmail is required.', 422);
  const recipient = await User.findOne({ email: recipientEmail.toLowerCase().trim() });
  if (!recipient) throw new AppError('No user found with that email — nothing was sent.', 404);
  if (recipient._id.equals(req.user._id)) throw new AppError('You cannot transfer to yourself.', 422);
  const reference = generateTransactionId();
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
      user: req.user._id, type: 'transfer_out', amount, currency: cur, counterparty: recipient._id, note: note || '', reference
    }], { session });
    await WalletTransaction.create([{
      user: recipient._id, type: 'transfer_in', amount, currency: cur, counterparty: req.user._id, note: note || '', reference
    }], { session });
    return { senderAvailable: senderWallet.available, recipientAvailable: recipientWallet.available };
  });
  await notify(recipient._id, {
    title: `You received ${cur} ${amount} from ${req.user.fullName}`, body: `Receipt ${reference}${note ? ` — ${note}` : ''}`, sentBy: req.user._id
  }).catch(() => {});
  return ok(res, { ...balances, reference, recipient: { fullName: recipient.fullName, email: recipient.email } }, `Transfer complete — receipt ${reference}.`);
});

module.exports = { getMyWallet, requestWithdrawal, listPendingWithdrawals, reviewWithdrawal, transfer };
