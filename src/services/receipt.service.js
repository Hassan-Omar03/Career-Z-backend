const mongoose = require('mongoose');
const Receipt = require('../models/Receipt');
const Counter = require('../models/Counter');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const TAX_KEY = 'receipt_tax_percent';
const GATEWAY_KEY = 'receipt_gateway_fee_percent';
const percent = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0; };

async function chargesConfig(session = null) {
  const query = Setting.find({ key: { $in: [TAX_KEY, GATEWAY_KEY] } });
  if (session) query.session(session);
  const rows = await query.lean();
  const of = (key) => percent(rows.find((r) => r.key === key)?.value);
  return { taxPercent: of(TAX_KEY), gatewayFeePercent: of(GATEWAY_KEY) };
}
async function setChargesConfig(body = {}) {
  for (const [key, value] of [[TAX_KEY, body.taxPercent], [GATEWAY_KEY, body.gatewayFeePercent]]) {
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new AppError('Enter a percentage from 0 to 100.', 422);
    await Setting.findOneAndUpdate({ key }, { key, value: n }, { upsert: true });
  }
  return chargesConfig();
}

async function nextNumber(session) {
  const year = new Date().getFullYear();
  const row = await Counter.findOneAndUpdate({ _id: `receipt-${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  return `RCP-${year}-${String(row.seq).padStart(6, '0')}`;
}

// Tax and gateway charges come out of CareerZ's own share, so what the seller receives never
// changes because of them. A payment is receipted once, whatever retries the gateway sends.
async function issue({ transactionType, transaction, reference = '', title = '', payer = null, recipient = null, payerName = '', recipientName = 'CareerZ', paymentMethod = '', grossAmount, currency, platformCommission = 0, netAmount, viaGateway = false }, session = null) {
  const existing = await Receipt.findOne({ transactionType, transaction }).session(session);
  if (existing) return existing;
  const { taxPercent, gatewayFeePercent } = await chargesConfig(session);
  const gross = round2(grossAmount), commission = round2(platformCommission);
  const [receipt] = await Receipt.create([{
    receiptNumber: await nextNumber(session), transactionType, transaction, reference, title, payer, recipient, payerName, recipientName, paymentMethod, currency,
    grossAmount: gross, platformCommission: commission, netAmount: round2(netAmount ?? gross - commission),
    taxAmount: round2((commission * taxPercent) / 100), gatewayFee: viaGateway ? round2((gross * gatewayFeePercent) / 100) : 0
  }], { session });
  return receipt;
}

// A bank transfer CareerZ verified. Payments to CareerZ itself carry no commission line; an
// escrow order's receipt shows the seller's share and CareerZ's fee.
async function issueForManualPayment(mp, session) {
  let recipient = mp.recipient || null, recipientName = mp.recipientSnapshot?.name || 'CareerZ';
  let gross = round2(Number(mp.commission || 0) + Number(mp.sellerAmount || 0));
  let commission = recipient ? round2(mp.commission) : 0;
  let net = recipient ? round2(mp.sellerAmount) : gross;
  if (mp.kind === 'marketplace_order' && mp.order) {
    const order = await require('../models/Order').findById(mp.order).select('seller totalPrice').populate('seller', 'fullName').session(session);
    if (order) { gross = round2(mp.price); net = round2(order.totalPrice); commission = round2(gross - net); recipient = order.seller?._id || null; recipientName = order.seller?.fullName || 'Seller'; }
  }
  if (mp.kind === 'freelance_milestone' && mp.freelanceOrder) {
    const order = await require('../models/FreelanceOrder').findById(mp.freelanceOrder).populate('seller', 'fullName').session(session);
    const m = order?.milestones.id(mp.freelanceMilestone);
    if (m) { gross = round2(mp.price); net = round2(m.amount); commission = round2(gross - net); recipient = order.seller?._id || null; recipientName = order.seller?.fullName || 'Freelancer'; }
  }
  return issue({ transactionType: 'ManualPayment', transaction: mp._id, reference: mp.number, title: mp.title, payer: mp.payer, recipient, payerName: mp.payerSnapshot?.name || '', recipientName, paymentMethod: 'Bank transfer', grossAmount: gross, currency: mp.currency, platformCommission: commission, netAmount: net }, session);
}

const GATEWAY_RATE = { fee: 'fee_commission_percent', course: 'course_commission_percent', tutoring_fee: 'tutoring_commission_percent' };
async function issueForGatewayPayment(payment, session) {
  const key = GATEWAY_RATE[payment.kind];
  const rate = key ? await require('../utils/receiptCalc').commissionRate(key, session, { amount: payment.amount }) : 0;
  const commission = round2((payment.amount * rate) / 100);
  return issue({ transactionType: 'JazzCashPayment', transaction: payment._id, reference: payment.retrievalReferenceNo || payment.txnRefNo, title: String(payment.kind).replace(/_/g, ' '), payer: payment.payer, paymentMethod: payment.provider === 'safepay' ? 'Safepay' : 'JazzCash', grossAmount: payment.amount, currency: payment.currency, platformCommission: commission, netAmount: round2(payment.amount - commission), viaGateway: true }, session);
}

const page = (n) => Math.max(1, Math.floor(Number(n)) || 1);
async function mine(user, query = {}) {
  const filter = { $or: [{ payer: user._id }, { recipient: user._id }] };
  return Receipt.find(filter).sort({ issuedAt: -1 }).skip((page(query.page) - 1) * 50).limit(50).lean();
}
async function adminList(query = {}) {
  const filter = {};
  const q = String(query.q || '').trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q) filter.$or = [{ receiptNumber: new RegExp(q, 'i') }, { reference: new RegExp(q, 'i') }, { payerName: new RegExp(q, 'i') }, { recipientName: new RegExp(q, 'i') }];
  const [rows, total] = await Promise.all([Receipt.find(filter).sort({ issuedAt: -1 }).skip((page(query.page) - 1) * 50).limit(50).lean(), Receipt.countDocuments(filter)]);
  return { rows, total };
}
async function readable(user, id, canSeeAll) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Receipt not found.', 404);
  const receipt = await Receipt.findById(id).lean();
  if (!receipt) throw new AppError('Receipt not found.', 404);
  const own = [receipt.payer, receipt.recipient].some((p) => p && String(p) === String(user._id));
  if (!own && !canSeeAll) throw new AppError('Receipt not found.', 404);
  return receipt;
}
// Public check by number: proves the receipt is genuine without showing who paid.
async function verify(number) {
  const receipt = await Receipt.findOne({ receiptNumber: String(number || '').trim().toUpperCase() }).select('receiptNumber title grossAmount currency issuedAt paymentMethod').lean();
  if (!receipt) throw new AppError('No receipt has this number.', 404);
  return receipt;
}

module.exports = { issue, issueForManualPayment, issueForGatewayPayment, mine, adminList, readable, verify, chargesConfig, setChargesConfig };
