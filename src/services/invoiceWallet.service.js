const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Institution = require('../models/Institution');
const User = require('../models/User');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const { generateTransactionId } = require('../utils/transactionId');

// Recruitment invoices paid inside CareerZ, wallet to wallet:
//   1. The institute pays from its wallet: the amount leaves its available balance and is held.
//   2. The admin approves: the agent's share goes straight to the agent's wallet and CareerZ's
//      commission to the platform wallet. Nobody hunts for bank accounts.
//   3. The admin rejects or asks for more: the held amount goes back to the institute's wallet.

const fail = (m, c = 422) => new AppError(m, c);

// The wallet that receives CareerZ's commission: Setting 'platform_wallet_user', else the first
// active Super Admin.
async function platformUserId() {
  const s = await Setting.findOne({ key: 'platform_wallet_user' }).lean();
  if (s?.value && mongoose.isValidObjectId(s.value)) return s.value;
  const admin = await User.findOne({ roles: 'super_admin', status: 'active' }).sort({ createdAt: 1 }).select('_id');
  if (!admin) throw fail('No platform wallet is set up.', 500);
  return admin._id;
}
async function payerId(invoice) {
  const institution = await Institution.findById(invoice.institution).select('owner name');
  return { owner: institution.owner, name: institution.name };
}

async function walletBalance(userId, currency) {
  const w = await Wallet.findOne({ user: userId, currency }).lean();
  return w?.available || 0;
}

// The institute pays the invoice from its wallet and it settles at once: the agent's share goes to
// the agent's wallet and CareerZ's commission to the platform wallet. Nothing is held.
async function payFromWallet(invoice, actor) {
  const { owner, name } = await payerId(invoice);
  const amount = invoice.grossFee;
  const reference = generateTransactionId();
  const platform = invoice.platformFee > 0 ? await platformUserId() : null;
  await mongoose.connection.transaction(async (session) => {
    // Claim the invoice first: a second click (or a parallel request) finds it already paid and
    // stops before any money moves.
    const open = await require('../models/RecruitmentInvoice').findOneAndUpdate(
      { _id: invoice._id, status: { $in: ['issued', 'more_info_requested'] } }, { $set: { status: 'paid' } }, { session });
    if (!open) throw fail('This invoice is already paid or waiting for CareerZ.', 409);
    const w = await Wallet.findOneAndUpdate({ user: owner, currency: invoice.currency, available: { $gte: amount } }, { $inc: { available: -amount } }, { new: true, session });
    if (!w) throw fail(`The institute wallet does not have ${invoice.currency} ${amount.toLocaleString()} available. Add money to the wallet first.`);
    await WalletTransaction.create([{ user: owner, type: 'transfer_out', amount, currency: invoice.currency, status: 'completed', counterparty: invoice.agent, reference, note: `Recruitment invoice ${invoice.number} · ${name}` }], { session });
    if (invoice.agentEarning > 0) {
      await Wallet.findOneAndUpdate({ user: invoice.agent, currency: invoice.currency }, { $inc: { available: invoice.agentEarning } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
      await WalletTransaction.create([{ user: invoice.agent, type: 'transfer_in', amount: invoice.agentEarning, currency: invoice.currency, counterparty: owner, reference, note: `Recruitment fee ${invoice.number} from ${name}` }], { session });
    }
    if (invoice.platformFee > 0) {
      await Wallet.findOneAndUpdate({ user: platform, currency: invoice.currency }, { $inc: { available: invoice.platformFee } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
      await WalletTransaction.create([{ user: platform, type: 'transfer_in', amount: invoice.platformFee, currency: invoice.currency, counterparty: owner, reference, note: `CareerZ commission on ${invoice.number} (${name})` }], { session });
    }
    const now = new Date();
    invoice.wallet = { reference, heldAt: now, releasedAt: now, paidBy: actor._id };
    invoice.status = 'paid';
    invoice.history.push({ action: 'paid_from_wallet', by: actor._id, note: `${invoice.currency} ${amount} paid from the institute wallet (ref ${reference}); agent and CareerZ paid at once` });
    await invoice.save({ session });
    await require('../models/Commission').updateOne({ _id: invoice.commission, status: 'pending' }, { $set: { status: 'paid' } }, { session });
  });
  return invoice;
}

// Step 2: approved → agent's share to the agent wallet, commission to the platform wallet.
async function release(invoice, admin) {
  const { owner, name } = await payerId(invoice);
  const platform = await platformUserId();
  await mongoose.connection.transaction(async (session) => {
    await WalletTransaction.updateOne({ user: owner, reference: invoice.wallet.reference, status: 'pending' }, { $set: { status: 'completed', processedBy: admin._id, processedAt: new Date() } }, { session });
    if (invoice.agentEarning > 0) {
      await Wallet.findOneAndUpdate({ user: invoice.agent, currency: invoice.currency }, { $inc: { available: invoice.agentEarning } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
      await WalletTransaction.create([{ user: invoice.agent, type: 'transfer_in', amount: invoice.agentEarning, currency: invoice.currency, counterparty: owner, reference: invoice.wallet.reference, note: `Recruitment fee ${invoice.number} from ${name} (after CareerZ commission ${invoice.currency} ${invoice.platformFee})` }], { session });
    }
    if (invoice.platformFee > 0) {
      await Wallet.findOneAndUpdate({ user: platform, currency: invoice.currency }, { $inc: { available: invoice.platformFee } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
      await WalletTransaction.create([{ user: platform, type: 'transfer_in', amount: invoice.platformFee, currency: invoice.currency, counterparty: owner, reference: invoice.wallet.reference, note: `CareerZ commission on ${invoice.number} (${name})` }], { session });
    }
    invoice.wallet.releasedAt = new Date();
    await invoice.save({ session });
  });
}

// Step 3 (reject / more info): the held amount goes back to the institute.
async function returnHeld(invoice, admin, reason) {
  const { owner } = await payerId(invoice);
  await mongoose.connection.transaction(async (session) => {
    await Wallet.findOneAndUpdate({ user: owner, currency: invoice.currency }, { $inc: { available: invoice.grossFee } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
    await WalletTransaction.updateOne({ user: owner, reference: invoice.wallet.reference, status: 'pending' }, { $set: { status: 'rejected', processedBy: admin._id, processedAt: new Date(), note: `Returned: ${reason}` } }, { session });
    invoice.wallet = { ...invoice.wallet.toObject?.() || invoice.wallet, returnedAt: new Date() };
    await invoice.save({ session });
  });
}

module.exports = { payFromWallet, release, returnHeld, walletBalance, platformUserId, payerId };
