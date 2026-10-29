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
const payoutAccount = require('../utils/payoutAccount');

// GET/PUT /api/wallet/payout-account — the bank account or mobile wallet withdrawals go to.
const getPayoutAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+payoutAccount roles');
  // Institutes, teachers, sellers and agents are paid by bank transfer into this account, and so
  // is a student with a funding request; their dashboard warns them until it is added.
  const SELLERS = ['institution_owner', 'academy_owner', 'teacher', 'marketplace_seller', 'education_agent'];
  const needed = (user?.roles || []).some((r) => SELLERS.includes(r)) || Boolean(await require('../models/Product').exists({ seller: req.user._id })) || Boolean(await require('../models/FundingRequest').exists({ requestedBy: req.user._id, status: 'open' }))
    || Boolean(await require('../models/Sponsorship').exists({ student: req.user._id, status: { $in: ['pending', 'active'] } }));
  return ok(res, { account: user?.payoutAccount?.accountNumber ? user.payoutAccount : null, needed, banks: payoutAccount.BANKS, wallets: payoutAccount.WALLETS });
});
const savePayoutAccount = asyncHandler(async (req, res) => {
  const account = { ...payoutAccount.normalize(req.body), updatedAt: new Date() };
  await User.updateOne({ _id: req.user._id }, { $set: { payoutAccount: account } });
  return ok(res, { account }, 'Payout account saved.');
});

const getMyWallet = asyncHandler(async (req, res) => {
  // Every balance the person holds, converted into the currency they chose to view (platform
  // exchange rates). Money itself stays in the currency it was paid in; withdrawals use that.
  const wallets = await Wallet.find({ user: req.user._id }).lean();
  const held = wallets.filter((w) => (w.available || 0) > 0 || (w.pending || 0) > 0);
  const codes = [...new Set([...held.map((w) => w.currency), String(req.query.currency || '').toUpperCase()])];
  const rates = Object.fromEntries((await require('../models/Currency').find({ code: { $in: codes } }).select('code exchangeRateToUSD').lean()).map((c) => [c.code, c.exchangeRateToUSD]));
  const usdOf = (w) => (rates[w.currency] ? (w.available || 0) * rates[w.currency] : 0);
  // The currency most of the money is in (withdrawals switch to it); PKR is shown by default.
  const primary = [...held].sort((a, b) => usdOf(b) - usdOf(a))[0]?.currency || 'PKR';
  const currency = req.query.currency ? normalizeCurrency(req.query.currency) : 'PKR';
  const wallet = wallets.find((w) => w.currency === currency);
  const round2 = (n) => Math.round(n * 100) / 100;
  let available = 0;
  let pending = 0;
  const unconverted = [];
  for (const w of held) {
    if (w.currency === currency) { available += w.available || 0; pending += w.pending || 0; continue; }
    if (!rates[w.currency] || !rates[currency]) { unconverted.push({ currency: w.currency, available: w.available || 0 }); continue; }
    available += ((w.available || 0) * rates[w.currency]) / rates[currency];
    pending += ((w.pending || 0) * rates[w.currency]) / rates[currency];
  }
  const transactions = await WalletTransaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  return ok(res, {
    currency, available: wallet?.available || 0, pending: wallet?.pending || 0, transactions,
    primaryCurrency: primary,
    balances: held.map((w) => ({ currency: w.currency, available: w.available || 0, pending: w.pending || 0 })),
    converted: { currency, available: round2(available), pending: round2(pending), unconverted }
  });
});

// Reserve funds and create the withdrawal record in the same transaction. A findable receipt
// (`reference`) is generated right here, at request time — not only once Admin approves it — so
// the requester always has proof a request exists, even if it's later rejected or never actioned.
// `accountTitle` (the name on the account) is required too: no real bank-verification API is
// connected here, so this is the honest substitute — it's entered explicitly by the requester and
// shown back to Admin on the review screen, rather than silently trusting a bare account number.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, currency } = req.body;
  validateAmount(amount);
  const cur = normalizeCurrency(currency);
  // The account sent with the request (saved as the default), else the saved one.
  let account;
  if (req.body.accountNumber || req.body.accountTitle || req.body.bankName) {
    account = payoutAccount.normalize(req.body);
    await User.updateOne({ _id: req.user._id }, { $set: { payoutAccount: { ...account, updatedAt: new Date() } } });
  } else {
    const user = await User.findById(req.user._id).select('+payoutAccount');
    if (!user?.payoutAccount?.accountNumber) throw new AppError('Add the bank account or mobile wallet to receive the money first.', 422);
    account = payoutAccount.normalize(user.payoutAccount);
  }
  const payoutMethod = account.method;
  const accountTitle = account.accountTitle;
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
      payoutDetails: payoutAccount.describe(account), reference
    }], { session });
    return entry;
  });
  await notifyAdmins({
    title: `New wallet withdrawal request: ${cur} ${amount}`,
    body: `${req.user.fullName} (${req.user.email}) requested a withdrawal to ${payoutAccount.describe(account)}. Receipt ${reference}.`
  }).catch(() => {});
  return ok(res, { ...tx.toObject(), id: tx.id, reference, accountTitle }, `Withdrawal requested. Receipt ${reference}. CareerZ will send it to your account.`);
});

const listPendingWithdrawals = asyncHandler(async (req, res) => {
  const list = await WalletTransaction.find({ type: 'withdrawal', status: 'pending' }).populate('user', 'fullName email').sort({ createdAt: 1 });
  return ok(res, list);
});

// Approval records the money the admin sent from CareerZ's bank (no payout API is connected yet),
// with that transfer's transaction id; rejection returns the reserved funds.
const reviewWithdrawal = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);
  const transferReference = String(req.body.transferReference || '').trim();
  if (decision === 'approved' && (transferReference.length < 4 || transferReference.length > 60)) throw new AppError('Enter the transaction ID of the transfer you sent.', 422);
  const reason = String(req.body.reason || '').trim().slice(0, 300);
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
    if (decision === 'approved') entry.payoutReference = transferReference;
    else if (reason) entry.note = reason;
    await entry.save({ session });
    return entry;
  });
  // Notifications cannot turn a committed payout into an API failure.
  await (async () => {
    const user = await User.findById(tx.user).select('email');
    await notify(tx.user, {
      title: `Withdrawal ${decision}: ${tx.currency} ${tx.amount}`,
      body: decision === 'approved' ? `Sent to ${tx.payoutDetails}. Transaction ID ${tx.payoutReference}.` : `Funds returned to your available balance.${reason ? ` Reason: ${reason}` : ''}`,
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

module.exports = { getMyWallet, getPayoutAccount, savePayoutAccount, requestWithdrawal, listPendingWithdrawals, reviewWithdrawal, transfer };
