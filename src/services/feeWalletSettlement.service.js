const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Institution = require('../models/Institution');
const Settlement = require('../models/FamilyWalletSettlement');
const FamilyPlatformBalance = require('../models/FamilyPlatformBalance');
const { commissionRate } = require('../utils/receiptCalc');

// A fee paid through a payment gateway is already confirmed by the gateway, so nothing is held:
// CareerZ keeps its commission and the rest goes straight to the institute owner's wallet, in
// the same transaction that marks the fee paid. One settlement row per gateway payment (its
// reference) makes a retried webhook credit nothing twice, and lets a refund take it back.

const GATEWAY_METHOD = /jazzcash|paddle|stripe|safepay|payfast|card|gateway/i;
const round2 = (n) => Math.round(n * 100) / 100;

async function creditInstitution(fee, { amount, reference, payerId }, session) {
  const value = round2(Number(amount) || 0);
  if (value <= 0 || !reference) return null;
  const existing = await Settlement.findOne({ reference }).session(session);
  if (existing) return existing;
  const school = await Institution.findById(fee.institution).select('owner name').session(session);
  if (!school?.owner) return null;
  const rate = await commissionRate('fee_commission_percent', session);
  const commission = round2((value * rate) / 100);
  const net = round2(value - commission);
  if (net > 0) {
    await Wallet.findOneAndUpdate({ user: school.owner, currency: fee.currency }, { $inc: { available: net } }, { upsert: true, session, setDefaultsOnInsert: true });
    await WalletTransaction.create([{ user: school.owner, type: 'transfer_in', amount: net, currency: fee.currency, reference: `${reference}-IN`, status: 'completed', counterparty: payerId || null, note: `Fee settlement: ${fee.title}` }], { session });
  }
  if (commission > 0) await FamilyPlatformBalance.findOneAndUpdate({ currency: fee.currency }, { $inc: { available: commission } }, { upsert: true, session, setDefaultsOnInsert: true });
  const [row] = await Settlement.create([{ reference, fee: fee._id, payer: payerId || school.owner, recipient: school.owner, amount: value, currency: fee.currency, commission, net }], { session });
  return row;
}

// Older gateway payments were held until an admin released them; releasing now pays them out.
// Payments made outside CareerZ (cash, a transfer to the institute's own account) are not
// credited, since that money is already with the institute.
async function creditHeldGatewayPayments(fee, session) {
  let credited = 0;
  for (const p of fee.paymentHistory || []) {
    if (!(p.verificationStatus === 'verified' || p.verifiedAt) || p.proofUrl || !GATEWAY_METHOD.test(p.method || '') || !p.transactionId) continue;
    const row = await creditInstitution(fee, { amount: p.amount, reference: `GW-${p.transactionId}`, payerId: p.recordedBy }, session);
    if (row) credited = round2(credited + row.net);
  }
  return credited;
}

// Course sales and tutoring fees paid through a gateway: CareerZ keeps its commission (a Super
// Admin setting per service) and the rest goes to the seller's wallet in the same transaction.
// The ledger reference makes a retried payment credit nothing twice.
async function creditEarner({ recipient, amount, currency, reference, payerId, note, commissionKey }, session) {
  const value = round2(Number(amount) || 0);
  if (value <= 0 || !recipient || !reference) return null;
  if (await WalletTransaction.exists({ reference: `${reference}-IN` }).session(session)) return null;
  const rate = await commissionRate(commissionKey, session);
  const commission = round2((value * rate) / 100);
  const net = round2(value - commission);
  if (net > 0) {
    await Wallet.findOneAndUpdate({ user: recipient, currency }, { $inc: { available: net } }, { upsert: true, session, setDefaultsOnInsert: true });
    await WalletTransaction.create([{ user: recipient, type: 'transfer_in', amount: net, currency, reference: `${reference}-IN`, status: 'completed', counterparty: payerId || null, note }], { session });
  }
  if (commission > 0) await FamilyPlatformBalance.findOneAndUpdate({ currency }, { $inc: { available: commission } }, { upsert: true, session, setDefaultsOnInsert: true });
  return { net, commission };
}

module.exports = { creditInstitution, creditHeldGatewayPayments, creditEarner, GATEWAY_METHOD };
