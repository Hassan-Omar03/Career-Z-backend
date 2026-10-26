const crypto = require('crypto');
const mongoose = require('mongoose');
const ManualPayment = require('../models/ManualPayment');
const User = require('../models/User');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const { commissionRate } = require('../utils/receiptCalc');
const { notify, notifyAdmins } = require('./notification.service');

// Manual payments (no gateway): the buyer pays CareerZ's service fee to the CareerZ account
// first, then the price straight to the seller's own account, and uploads both receipts. A
// CareerZ finance admin checks them — calling the buyer or the seller on the numbers shown if
// needed, and suspending a fraudster — and only then is the purchase granted.

const fail = (m, c = 422) => new AppError(m, c);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const PLATFORM_ACCOUNT_KEY = 'platform_payment_account';
const PHONE = /^\+?\d[\d\s-]{8,16}\d$/;
const MAX_FILE = 2 * 1024 * 1024; // two receipts must fit in one 6 MB request
const PROOF_MAX_AGE_DAYS = 30;

// ---------------------------------------------------------------- CareerZ's receiving account
async function platformAccount() {
  const s = await Setting.findOne({ key: PLATFORM_ACCOUNT_KEY }).lean();
  const v = s?.value || {};
  return { accountTitle: v.accountTitle || '', bankName: v.bankName || '', accountNumber: v.accountNumber || '', iban: v.iban || '', qr: v.qr || '' };
}
async function savePlatformAccount(body = {}) {
  const v = {
    accountTitle: String(body.accountTitle || '').trim().slice(0, 80),
    bankName: String(body.bankName || '').trim().slice(0, 60),
    accountNumber: String(body.accountNumber || '').replace(/[\s-]/g, '').slice(0, 30),
    iban: String(body.iban || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 34),
    qr: String(body.qr || '')
  };
  if (!v.accountTitle || !v.bankName || !(v.accountNumber || v.iban)) throw fail('Enter the account title, bank and account number or IBAN.');
  if (v.iban && !/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(v.iban)) throw fail('The IBAN is not valid.');
  if (v.qr && (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(v.qr) || v.qr.length > 1.5 * 1024 * 1024)) throw fail('Upload the QR code as a PNG, JPG or WEBP image under 1 MB.');
  await Setting.findOneAndUpdate({ key: PLATFORM_ACCOUNT_KEY }, { key: PLATFORM_ACCOUNT_KEY, value: v }, { upsert: true });
  return v;
}

// ---------------------------------------------------------------- what is being bought
async function toPkr(amount, currency) {
  if (currency === 'PKR') return { amount: round2(amount), currency: 'PKR' };
  const Currency = require('../models/Currency');
  const [from, pkr] = await Promise.all([Currency.findOne({ code: currency }).select('exchangeRateToUSD'), Currency.findOne({ code: 'PKR' }).select('exchangeRateToUSD')]);
  if (!from?.exchangeRateToUSD || !pkr?.exchangeRateToUSD) return { amount: round2(amount), currency };
  return { amount: round2((amount * from.exchangeRateToUSD) / pkr.exchangeRateToUSD), currency: 'PKR' };
}

async function guardianOrStudent(studentId, user, action) {
  if (String(studentId) === String(user._id)) return;
  const link = await require('../models/ParentChildLink').findOne({ parent: user._id, student: studentId, status: 'approved' }).select('permissions');
  if (!link || link.permissions?.payFees === false) throw fail(`Only the student or their parent can ${action}.`, 403);
}

// Each kind: who receives the money, how much, and which commission rate applies.
// recipient = null means CareerZ itself is the seller (the whole amount goes to the CareerZ account).
const RESOLVERS = {
  async fee(user, id) {
    const Fee = require('../models/Fee');
    const fee = await Fee.findById(id);
    if (!fee) throw fail('Fee not found.', 404);
    await require('../controllers/payment.controller').assertCanPayFee(fee, user);
    const owed = require('./feeSettlement.service').assertPayableOnline(fee);
    const school = await require('../models/Institution').findById(fee.institution).select('owner name');
    return { title: `${fee.title} (${school?.name || 'Institute'})`, price: owed, currency: fee.currency || 'PKR', recipient: school?.owner, rateKey: 'fee_commission_percent', refs: { fee: fee._id, institution: fee.institution } };
  },
  async course(user, id) {
    const { course, amountMinor, currency } = await require('../controllers/payment.controller').loadPayableCourse(id, user._id);
    const school = course.institution ? await require('../models/Institution').findById(course.institution).select('owner') : null;
    return { title: `Course: ${course.title}`, price: amountMinor / 100, currency, recipient: school?.owner || course.teacher, rateKey: 'course_commission_percent', refs: { course: course._id } };
  },
  async tutoring(user, id) {
    const link = await require('../models/TeacherStudentLink').findById(id).populate('course', 'title');
    if (!link) throw fail('Tuition not found.', 404);
    await guardianOrStudent(link.student, user, 'pay this fee');
    if (!['active', 'paused'].includes(link.status)) throw fail('This tuition is not active.', 400);
    if (!(link.feeAmount > 0)) throw fail('No fee is set for this tuition.', 400);
    if (link.feePaidAt) throw fail('This fee has already been paid.', 409);
    return { title: `Tuition fee: ${link.course?.title || link.subject || 'tutor'}`, price: link.feeAmount, currency: link.feeCurrency || 'PKR', recipient: link.teacher, rateKey: 'tutoring_commission_percent', refs: { tutoringLink: link._id } };
  },
  async marketplace_order(user, id) {
    const order = await require('../models/Order').findById(id).populate('product', 'category title');
    if (!order) throw fail('Order not found.', 404);
    if (String(order.buyer) !== String(user._id)) throw fail('Only the buyer can pay for this order.', 403);
    if (order.paymentStatus !== 'pending' || ['cancelled', 'refunded'].includes(order.status)) throw fail('This order is not waiting for payment.', 409);
    const category = order.product?.category;
    const rateKey = category && await Setting.exists({ key: `marketplace_commission_percent:${category}` }) ? `marketplace_commission_percent:${category}` : 'marketplace_commission_percent';
    return { title: `Order: ${order.product?.title || 'item'}`, price: order.totalPrice, currency: order.currency || 'PKR', recipient: order.seller, rateKey, refs: { order: order._id } };
  },
  async donation(user, id, body) {
    const request = await require('../models/FundingRequest').findById(id).populate('requestedBy', '_id');
    if (!request) throw fail('Funding request not found.', 404);
    if (request.requestedBy._id.equals(user._id)) throw fail('You cannot donate to your own funding request.', 403);
    if (request.status !== 'open' || request.applicationStatus === 'rejected') throw fail('This request is no longer open for donations.', 400);
    if (request.verificationStatus !== 'verified') throw fail('Only Super Admin-verified requests can receive donations.', 403);
    const amount = round2(body.amount);
    if (!(amount >= 1)) throw fail('Enter the amount you want to give.');
    return { title: `Donation: ${request.title}`, price: amount, currency: request.currency || 'PKR', recipient: request.requestedBy._id, rateKey: 'donation_commission_percent', refs: { fundingRequest: request._id }, openSuffix: '', donation: true };
  },
  async featured_job(user, id) {
    const { job, fee, days } = await require('../controllers/job.controller').loadFeaturableJob(id, user._id);
    return { title: `Featured job for ${days} days: ${job.title}`, price: fee, currency: 'USD', recipient: null, refs: { job: job._id } };
  },
  async subscription(user, id, body) {
    const institution = await require('../models/Institution').findById(id);
    if (!institution) throw fail('Institution not found.', 404);
    if (String(institution.owner) !== String(user._id)) throw fail('Only the institution owner can change its plan.', 403);
    const { getEffectivePlans } = require('../utils/subscriptionGate');
    const { PAID_PLAN_KEYS } = require('../config/subscriptionPlans');
    if (!PAID_PLAN_KEYS.includes(body.plan)) throw fail('Choose a paid plan.');
    const plans = await getEffectivePlans();
    const price = plans[body.plan].monthlyPriceUSD;
    if (!(price > 0)) throw fail('This plan has no price yet.', 503);
    return { title: `CareerZ ${plans[body.plan].label} plan, 30 days`, price, currency: 'USD', recipient: null, refs: { institution: institution._id, plan: body.plan } };
  },
  // The employer pays the agent's commission for a hire on a job it accepted (CareerZ fee on top).
  async agent_commission(user, id) {
    if (!mongoose.isValidObjectId(id)) throw fail('Commission not found.', 404);
    const c = await require('../models/Commission').findById(id).populate('job', 'title');
    if (!c || String(c.employer) !== String(user._id)) throw fail('Commission not found.', 404);
    if (!['pending', 'approved', 'available'].includes(c.status)) throw fail('This commission is not waiting for payment.', 409);
    return { title: `Agent commission: ${c.job?.title || 'hire'}`, price: c.amount, currency: c.currency || 'PKR', recipient: c.agent, rateKey: 'recruitment_platform_fee_percent', refs: { agentCommission: c._id } };
  },
  // The institute pays an agreement invoice: CareerZ's fee as fixed on the invoice, then the agent's share.
  async recruitment_invoice(user, id) {
    if (!mongoose.isValidObjectId(id)) throw fail('Invoice not found.', 404);
    const { invoice, isInstitution } = await require('./recruitment.service').invoiceForParty(user, id);
    if (!isInstitution) throw fail('Only the institute can pay this invoice.', 403);
    if (!['issued', 'more_info_requested'].includes(invoice.status)) throw fail(`This invoice is ${invoice.status.replace(/_/g, ' ')}.`, 409);
    return { title: `Recruitment invoice ${invoice.number}`, price: invoice.agentEarning, fixedCommission: invoice.platformFee, currency: invoice.currency || 'PKR', recipient: invoice.agent, refs: { recruitmentInvoice: invoice._id, institution: invoice.institution } };
  },
  // A donor pays an approved scholarship student (all of it or an instalment).
  async sponsorship_payment(user, id, body) {
    if (!mongoose.isValidObjectId(id)) throw fail('Sponsorship not found.', 404);
    const s = await require('../models/Sponsorship').findById(id).populate('scholarship', 'title');
    if (!s || String(s.donor) !== String(user._id)) throw fail('Sponsorship not found.', 404);
    if (['completed', 'cancelled', 'paused'].includes(s.status)) throw fail(`This sponsorship is ${s.status}.`, 409);
    const remaining = round2((s.amount || 0) - (s.paidAmount || 0));
    if (!(remaining > 0)) throw fail('This sponsorship is fully paid.', 409);
    const amount = body.amount != null && body.amount !== '' ? round2(body.amount) : remaining;
    if (!(amount > 0) || amount > remaining) throw fail(`Enter an amount up to the remaining ${s.currency} ${remaining}.`);
    return { title: `Scholarship: ${s.scholarship?.title || 'sponsorship'}`, price: amount, currency: s.currency || 'PKR', recipient: s.student, rateKey: 'scholarship_commission_percent', refs: { sponsorship: s._id }, donation: true };
  },
  async wallet_topup(user, id, body) {
    const amount = round2(body.amount);
    if (!(amount >= 1)) throw fail('Enter the amount to add.');
    const currency = require('../utils/walletInput').normalizeCurrency(body.currency || 'PKR');
    return { title: `Wallet top-up ${currency} ${amount}`, price: amount, currency, recipient: null, refs: {}, openSuffix: `${user._id}:${currency}` };
  }
};

// The amounts and both accounts the buyer must pay to.
async function quote(user, kind, id, body = {}) {
  const resolve = RESOLVERS[kind];
  if (!resolve) throw fail('Unknown payment type.', 404);
  const item = await resolve(user, id, body);
  const { amount: price, currency } = await toPkr(item.price, item.currency);
  const careerz = await platformAccount();
  if (!careerz.accountTitle) throw fail('CareerZ has not published its payment account yet. Please try again later.', 503);
  let rate = 0;
  let commission = price;
  let sellerAmount = 0;
  let recipient = null;
  if (item.recipient) {
    // A fee already fixed (an agreement invoice) is used as it is; otherwise the service rate on top.
    rate = item.fixedCommission != null ? (price > 0 ? round2((item.fixedCommission / price) * 100) : 0) : await commissionRate(item.rateKey);
    commission = item.fixedCommission != null ? round2(item.fixedCommission) : round2((price * rate) / 100);
    sellerAmount = price;
    recipient = await User.findById(item.recipient).select('fullName email phone status +payoutAccount');
    if (!recipient || recipient.status !== 'active') throw fail('The seller account is not active.', 409);
    if (String(recipient._id) === String(user._id)) throw fail('You cannot pay yourself.', 403);
    if (!recipient.payoutAccount?.accountNumber) throw fail(`${recipient.fullName} has not added the bank or wallet account to receive payments yet.`, 409);
  }
  const openKey = `${kind}:${item.openSuffix ?? String(id)}${kind === 'donation' ? `:${user._id}` : ''}`;
  const open = await ManualPayment.findOne({ openKey }).select('status payer number commission commissionLeg');
  if (open && String(open.payer) !== String(user._id)) throw fail('Someone else has already sent a payment for this; CareerZ is checking it.', 409);
  // commission: pay CareerZ first · waiting: CareerZ is checking that · seller: pay the seller · checking: all sent
  const stage = !open ? (commission > 0 && sellerAmount > 0 ? 'commission' : 'seller') : open.status === 'commission_verified' ? 'seller' : open.status === 'commission_submitted' ? 'waiting' : 'checking';
  const account = recipient ? { method: recipient.payoutAccount.method, bankName: recipient.payoutAccount.bankName, accountTitle: recipient.payoutAccount.accountTitle, accountNumber: recipient.payoutAccount.accountNumber } : null;
  const threshold = item.donation ? await require('./donorWork.service').largeDonationThreshold() : 0;
  const pricePkr = currency === 'PKR' ? price : (await toPkr(price, currency)).amount;
  return {
    kind, id: String(id || ''), title: item.title, currency, price, commissionRate: rate, commission, sellerAmount, total: round2(commission + sellerAmount),
    stage, paymentNumber: open?.number || '', sourceOfFundsRequired: Boolean(threshold && pricePkr >= threshold && stage !== 'seller'),
    careerzAccount: careerz,
    // The seller's account is shown only once CareerZ's fee is confirmed (or when there is no fee).
    seller: recipient ? { id: recipient._id, name: recipient.fullName, phone: recipient.phone || '', account: stage === 'seller' ? account : null, _account: account } : null,
    refs: item.refs, openKey
  };
}

// ---------------------------------------------------------------- submitting the receipts
const txnKey = (t) => String(t || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
async function storeProof(file, owner) {
  const match = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(file?.data || ''));
  if (!match) throw fail('Upload each receipt as a PDF, PNG, JPG or WEBP file.');
  const data = Buffer.from(match[3], 'base64');
  if (data.length > MAX_FILE) throw fail('Each receipt must be 2 MB or smaller.');
  return (await require('../models/PrivateFile').create({ purpose: 'payment_proof', owner, filename: String(file.name || 'receipt').slice(0, 160), mimeType: match[1], size: data.length, data }))._id;
}
function checkLeg(leg, expected, label) {
  if (!leg) throw fail(`Add the ${label} receipt.`);
  const key = txnKey(leg.transactionId);
  if (key.length < 6 || key.length > 40) throw fail(`Enter the transaction ID of the ${label} transfer (6 to 40 letters or numbers).`);
  if (Math.abs(round2(leg.amount) - expected) > 0.009) throw fail(`The ${label} amount must be exactly ${expected}.`);
  const paidOn = new Date(leg.paidOn);
  if (Number.isNaN(paidOn.getTime()) || paidOn > new Date(Date.now() + 864e5) || paidOn < new Date(Date.now() - PROOF_MAX_AGE_DAYS * 864e5)) throw fail(`Enter the date of the ${label} transfer (within the last ${PROOF_MAX_AGE_DAYS} days).`);
  if (!leg.file?.data) throw fail(`Attach the ${label} receipt or screenshot.`);
  return { key, paidOn };
}

async function submit(user, kind, id, body = {}) {
  const q = await quote(user, kind, id, body);
  // The admin calls this number to check the payment.
  const phone = String(body.phone || user.phone || '').trim();
  if (!PHONE.test(phone)) throw fail('Enter your phone number so CareerZ can call you about this payment.');
  if (!user.phone || user.phone !== phone) await User.updateOne({ _id: user._id }, { $set: { phone } });
  if (q.stage === 'waiting') throw fail('CareerZ is checking your service fee payment. You can pay the seller once it is confirmed.', 409);
  if (q.stage === 'checking') throw fail('A payment for this is already waiting for CareerZ to check it.', 409);
  const now = new Date();
  // Step 2: CareerZ confirmed the fee; now the seller receipt.
  if (q.stage === 'seller' && q.paymentNumber) {
    const s = checkLeg(body.seller, q.sellerAmount, 'seller payment');
    if (await ManualPayment.exists({ txnKeys: s.key })) throw fail('This transaction ID was already used for another payment.', 409);
    const sellerLeg = { amount: q.sellerAmount, transactionId: String(body.seller.transactionId).trim(), paidOn: s.paidOn, file: await storeProof(body.seller.file, user._id), submittedAt: now };
    let mp;
    try {
      mp = await ManualPayment.findOneAndUpdate({ number: q.paymentNumber, payer: user._id, status: 'commission_verified' },
        { $set: { sellerLeg, status: 'submitted', 'recipientSnapshot.account': q.seller._account }, $push: { txnKeys: s.key, history: { action: 'seller_paid', by: user._id, note: `${q.currency} ${q.sellerAmount}` } } }, { new: true });
    } catch (e) {
      if (e?.code === 11000) throw fail('This transaction ID was already used for another payment.', 409);
      throw e;
    }
    if (!mp) throw fail('This payment changed; please reload.', 409);
    await notifyAdmins({ title: `Seller payment to verify: ${mp.number}`, body: `${q.title}: ${q.currency} ${q.sellerAmount} to ${q.seller.name}.` }).catch(() => {});
    await notify(mp.recipient, { title: `Payment sent to your account: ${q.currency} ${q.sellerAmount}`, body: `${user.fullName} says they paid you for ${q.title} (transaction ${sellerLeg.transactionId}). Please confirm in your wallet whether it arrived.`, link: '/dashboard?tab=wallet' }).catch(() => {});
    return mp;
  }
  // Step 1 (with a CareerZ fee): only the fee receipt; the seller is paid after CareerZ confirms it.
  const twoStep = q.commission > 0 && q.sellerAmount > 0;
  const sourceOfFunds = String(body.sourceOfFunds || '').trim().slice(0, 1000);
  if (q.sourceOfFundsRequired && sourceOfFunds.length < 10) throw fail('This is a large donation: say where the money comes from (for example salary, business income, family trust).');
  const legs = [];
  const c = q.commission > 0 ? checkLeg(body.commission, q.commission, q.seller ? 'CareerZ service fee' : 'CareerZ payment') : null;
  if (c) legs.push(c.key);
  const s = !twoStep && q.sellerAmount > 0 ? checkLeg(body.seller, q.sellerAmount, 'seller payment') : null;
  if (s) legs.push(s.key);
  if (legs.length && await ManualPayment.exists({ txnKeys: { $in: legs } })) throw fail('This transaction ID was already used for another payment.', 409);
  const commissionLeg = c ? { amount: q.commission, transactionId: String(body.commission.transactionId).trim(), paidOn: c.paidOn, file: await storeProof(body.commission.file, user._id), submittedAt: now } : null;
  const sellerLeg = s ? { amount: q.sellerAmount, transactionId: String(body.seller.transactionId).trim(), paidOn: s.paidOn, file: await storeProof(body.seller.file, user._id), submittedAt: now } : null;
  let mp;
  try {
    mp = await ManualPayment.create({
      number: `MP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      kind, title: q.title, payer: user._id, submittedBy: user._id,
      payerSnapshot: { name: user.fullName, email: user.email, phone },
      recipient: q.seller?.id || null,
      recipientSnapshot: q.seller ? { name: q.seller.name, email: '', phone: q.seller.phone, account: twoStep ? null : q.seller._account } : null,
      ...q.refs, currency: q.currency, price: q.price, commissionRate: q.commissionRate, commission: q.commission, sellerAmount: q.sellerAmount,
      commissionLeg, sellerLeg, txnKeys: legs, openKey: q.openKey, status: twoStep ? 'commission_submitted' : 'submitted', sourceOfFunds,
      history: [{ action: twoStep ? 'service_fee_paid' : 'submitted', by: user._id, note: `${q.currency} ${twoStep ? q.commission : q.total}` }]
    });
  } catch (e) {
    if (e?.code === 11000) throw fail('This payment or transaction ID was already submitted.', 409);
    throw e;
  }
  await notifyAdmins({ title: twoStep ? `CareerZ service fee to verify: ${mp.number}` : `Manual payment to verify: ${mp.number}`, body: `${q.title}: ${q.currency} ${twoStep ? q.commission : q.total} from ${user.fullName} (${phone}).` }).catch(() => {});
  if (mp.recipient && sellerLeg) await notify(mp.recipient, { title: `Payment sent to your account: ${q.currency} ${q.sellerAmount}`, body: `${user.fullName} says they paid you for ${q.title} (transaction ${sellerLeg.transactionId}). Please confirm in your wallet whether it arrived.`, link: '/dashboard?tab=wallet' }).catch(() => {});
  return mp;
}

// The seller says whether the money reached their account (helps the admin decide).
async function confirmReceived(user, id, { received, note }) {
  const mp = await ManualPayment.findById(id);
  if (!mp || String(mp.recipient) !== String(user._id)) throw fail('Payment not found.', 404);
  if (mp.status !== 'submitted') throw fail('This payment was already decided.', 409);
  if (typeof received !== 'boolean') throw fail('Say whether the money arrived.');
  mp.recipientConfirmation = { received, note: String(note || '').trim().slice(0, 300), at: new Date() };
  mp.history.push({ action: received ? 'seller_confirmed' : 'seller_denied', by: user._id, note: mp.recipientConfirmation.note });
  await mp.save();
  if (!received) await notifyAdmins({ title: `Seller says payment did NOT arrive: ${mp.number}`, body: `${mp.title}. ${mp.recipientConfirmation.note}` }).catch(() => {});
  return mp;
}

// ---------------------------------------------------------------- admin decision
async function grant(mp, session) {
  const ref = mp.number;
  if (mp.kind === 'fee') {
    const Fee = require('../models/Fee');
    const fee = await Fee.findById(mp.fee).session(session);
    const settlement = require('./feeSettlement.service');
    const result = settlement.applyOnlinePayment(fee, { amount: mp.price, method: 'bank_transfer', paidVia: 'Bank transfer (verified by CareerZ)', transactionId: ref, payerId: mp.payer });
    if (result.duplicate) throw fail('This fee was already paid.', 409);
    if (fee.status === 'paid') {
      fee.receiptNumber = fee.receiptNumber || `RCPT-${Date.now().toString(36).toUpperCase()}-${ref.slice(-6)}`;
      fee.verifyCode = fee.verifyCode || crypto.randomBytes(10).toString('hex');
      fee.escrowStatus = 'released';
      fee.escrowReleasedAt = new Date();
    }
    await fee.save({ session });
  } else if (mp.kind === 'course') {
    const course = await require('../models/Course').findById(mp.course).session(session);
    await require('../models/CoursePurchase').create([{ course: mp.course, student: mp.payer, provider: 'manual', providerCheckoutId: ref, amountMinor: Math.round(Number(course?.price || mp.price) * 100), currency: course?.currency || mp.currency, status: 'paid', paidAt: new Date(), providerPaymentId: ref }], { session });
    await require('../models/Enrollment').updateOne({ student: mp.payer, course: mp.course }, { $setOnInsert: { student: mp.payer, course: mp.course } }, { upsert: true, session });
  } else if (mp.kind === 'tutoring') {
    const link = await require('../models/TeacherStudentLink').findById(mp.tutoringLink).session(session);
    if (link.feePaidAt) throw fail('This fee was already paid.', 409);
    const payer = await require('./feePayer.service').payerInfo(mp.payer, link.student);
    Object.assign(link, { feePaidAt: new Date(), feePaidBy: mp.payer, feePaidByRole: payer?.role || 'Student', feeReceipt: ref });
    await link.save({ session });
  } else if (mp.kind === 'marketplace_order') {
    const r = await require('../models/Order').updateOne({ _id: mp.order, paymentStatus: 'pending' }, { $set: { paymentStatus: 'paid' } }, { session });
    if (!r.modifiedCount) throw fail('This order is no longer waiting for payment.', 409);
  } else if (mp.kind === 'donation') {
    const FundingRequest = require('../models/FundingRequest');
    const request = await FundingRequest.findById(mp.fundingRequest).session(session);
    const [donation] = await require('../models/Donation').create([{
      donor: mp.payer, receiver: mp.recipient, fundingRequest: mp.fundingRequest, amount: mp.price, currency: mp.currency, type: 'donation',
      paymentMethod: 'bank_transfer', paymentReference: mp.sellerLeg?.transactionId || ref, paidOn: mp.sellerLeg?.paidOn || new Date(), status: 'successful',
      transactionId: ref, grossAmount: round2(mp.price + mp.commission), platformCommission: mp.commission, gatewayCharges: 0, taxAmount: 0, netAmount: mp.price,
      escrowStatus: 'released', verifiedAt: new Date()
    }], { session });
    mp.donation = donation._id;
    const updated = await FundingRequest.findByIdAndUpdate(request._id, { $inc: { collectedAmount: mp.price } }, { new: true, session });
    if (updated.collectedAmount >= updated.requiredAmount) { updated.status = 'fulfilled'; updated.applicationStatus = 'funded'; } else updated.applicationStatus = 'partially_funded';
    await updated.save({ session });
  } else if (mp.kind === 'featured_job') {
    const { job, fee, days } = await require('../controllers/job.controller').loadFeaturableJob(mp.job, mp.payer);
    const [listing] = await require('../models/FeaturedListing').create([{ listingType: 'job', job: job._id, purchasedBy: mp.payer, amount: fee, currency: 'USD', paymentMethod: 'bank_transfer', status: 'pending', expiresAt: new Date(Date.now() + days * 864e5) }], { session });
    await require('../controllers/webhook.controller').settleFeaturedListing(listing, ref, session);
  } else if (mp.kind === 'subscription') {
    const [purchase] = await require('../models/SubscriptionPurchase').create([{ institution: mp.institution, plan: mp.plan, purchasedBy: mp.payer, amount: mp.price, currency: mp.currency, paymentMethod: 'bank_transfer', status: 'pending' }], { session });
    await require('../controllers/webhook.controller').settleSubscriptionPurchase(purchase, ref, session);
  } else if (mp.kind === 'agent_commission') {
    const r = await require('../models/Commission').updateOne({ _id: mp.agentCommission, status: { $in: ['pending', 'approved', 'available'] } }, { $set: { status: 'paid' } }, { session });
    if (!r.modifiedCount) throw fail('This commission is no longer waiting for payment.', 409);
  } else if (mp.kind === 'recruitment_invoice') {
    const RecruitmentInvoice = require('../models/RecruitmentInvoice');
    const invoice = await RecruitmentInvoice.findOneAndUpdate({ _id: mp.recruitmentInvoice, status: { $in: ['issued', 'more_info_requested'] } }, { $set: { status: 'paid' }, $push: { history: { action: 'payment_verified', by: mp.review?.by || null, note: `Paid by bank transfer: CareerZ fee to CareerZ, agent share to the agent (${ref})` } } }, { new: true, session });
    if (!invoice) throw fail('This invoice is no longer waiting for payment.', 409);
    if (invoice.commission) await require('../models/Commission').updateOne({ _id: invoice.commission }, { $set: { status: 'paid' } }, { session });
  } else if (mp.kind === 'sponsorship_payment') {
    const s = await require('../models/Sponsorship').findById(mp.sponsorship).session(session);
    if (!s) throw fail('Sponsorship not found.', 404);
    const amount = Math.min(mp.price, round2((s.amount || 0) - (s.paidAmount || 0)));
    if (!(amount > 0)) throw fail('This sponsorship is already fully paid.', 409);
    s.paymentHistory.push({ amount, paymentMethod: 'bank_transfer', reference: ref, provider: 'Verified by CareerZ', status: 'verified', verifiedAt: new Date() });
    s.paidAmount = round2((s.paidAmount || 0) + amount);
    s.status = s.paidAmount >= s.amount ? 'completed' : 'active';
    await s.save({ session });
  } else if (mp.kind === 'wallet_topup') {
    await require('../models/Wallet').findOneAndUpdate({ user: mp.payer, currency: mp.currency }, { $inc: { available: mp.price } }, { upsert: true, session, setDefaultsOnInsert: true });
    await require('../models/WalletTransaction').create([{ user: mp.payer, type: 'topup', amount: mp.price, currency: mp.currency, status: 'completed', reference: ref, note: 'Bank transfer top-up (verified by CareerZ)' }], { session });
  }
}

async function decide(admin, id, { decision, note }) {
  await require('../utils/platformFinance').assertPlatformFinance(admin);
  if (!['approve', 'reject'].includes(decision)) throw fail('decision must be approve or reject.');
  const text = String(note || '').trim().slice(0, 500);
  if (decision === 'reject' && !text) throw fail('Write why it is rejected; the buyer is told.');
  const mp = await ManualPayment.findById(id);
  if (!mp) throw fail('Payment not found.', 404);
  // Step 1 decision: the CareerZ fee arrived (the buyer may now pay the seller) or it did not.
  if (mp.status === 'commission_submitted') {
    const set = decision === 'approve'
      ? { status: 'commission_verified', review: { by: admin._id, at: new Date(), note: text } }
      : { status: 'rejected', openKey: null, review: { by: admin._id, at: new Date(), note: text } };
    const claimed = await ManualPayment.findOneAndUpdate({ _id: mp._id, status: 'commission_submitted' }, { $set: set, $push: { history: { action: decision === 'approve' ? 'service_fee_verified' : 'rejected', by: admin._id, note: text } } }, { new: true });
    if (!claimed) throw fail('This payment was already decided.', 409);
    await notify(claimed.payer, decision === 'approve'
      ? { title: `Service fee confirmed: ${claimed.title}`, body: `Now pay ${claimed.recipientSnapshot?.name || 'the seller'} ${claimed.currency} ${claimed.sellerAmount} and upload the receipt. Ref ${claimed.number}.`, link: '/dashboard' }
      : { title: `Service fee not verified: ${claimed.title}`, body: `${text} Ref ${claimed.number}.`, link: '/dashboard' }, { email: true }).catch(() => {});
    return claimed;
  }
  if (mp.status !== 'submitted') throw fail(mp.status === 'commission_verified' ? 'The buyer has not sent the seller payment yet.' : 'This payment was already decided.', 409);
  if (decision === 'approve' && mp.recipient && mp.recipientConfirmation?.received === false && !text) {
    throw fail('The seller says this money did not arrive. Call them, then write what they confirmed before approving.');
  }
  await mongoose.connection.transaction(async (session) => {
    // Claimed in the transaction: two admins (or a double click) decide it once.
    const claimed = await ManualPayment.findOneAndUpdate({ _id: mp._id, status: 'submitted' }, { $set: { status: decision === 'approve' ? 'approved' : 'rejected', openKey: null, review: { by: admin._id, at: new Date(), note: text } }, $push: { history: { action: decision === 'approve' ? 'approved' : 'rejected', by: admin._id, note: text } } }, { new: true, session });
    if (!claimed) throw fail('This payment was already decided.', 409);
    if (decision === 'approve') {
      await grant(claimed, session);
      await claimed.save({ session });
    }
  });
  const fresh = await ManualPayment.findById(mp._id);
  const total = round2(fresh.commission + fresh.sellerAmount);
  await notify(fresh.payer, decision === 'approve'
    ? { title: `Payment verified: ${fresh.title}`, body: `${fresh.currency} ${total} confirmed by CareerZ. Ref ${fresh.number}.`, link: '/dashboard' }
    : { title: `Payment not verified: ${fresh.title}`, body: `${text} Ref ${fresh.number}. Contact CareerZ support if you think this is wrong.`, link: '/dashboard' }, { email: true }).catch(() => {});
  if (fresh.recipient) await notify(fresh.recipient, { title: decision === 'approve' ? `Sale confirmed: ${fresh.title}` : `Payment rejected: ${fresh.title}`, body: decision === 'approve' ? `CareerZ verified ${fresh.currency} ${fresh.sellerAmount} paid to your account.` : text }).catch(() => {});
  return fresh;
}

// ---------------------------------------------------------------- lists and receipts
const ADMIN_FIELDS = 'fullName email phone status';
async function adminList(admin, { status = 'submitted' } = {}) {
  await require('../utils/platformFinance').assertPlatformFinance(admin);
  const filter = status === 'submitted' ? { status: { $in: ['commission_submitted', 'submitted'] } } : ['commission_verified', 'approved', 'rejected'].includes(status) ? { status } : {};
  return ManualPayment.find(filter).populate('payer', ADMIN_FIELDS).populate('recipient', ADMIN_FIELDS).sort({ createdAt: status === 'submitted' ? 1 : -1 }).limit(300).lean();
}
const mine = (user) => ManualPayment.find({ payer: user._id }).select('-txnKeys -openKey').sort({ createdAt: -1 }).limit(100).lean();
const incoming = (user) => ManualPayment.find({ recipient: user._id, sellerLeg: { $ne: null } }).select('number kind title currency sellerAmount sellerLeg.transactionId sellerLeg.paidOn payerSnapshot.name status recipientConfirmation createdAt').sort({ createdAt: -1 }).limit(100).lean();

// Admin: both receipts. Buyer: their own. Seller: only the receipt of the money sent to them.
async function proof(user, id, leg) {
  if (!['commission', 'seller'].includes(leg)) throw fail('Receipt not found.', 404);
  const mp = await ManualPayment.findById(id);
  if (!mp) throw fail('Receipt not found.', 404);
  const isFinance = await require('../utils/platformFinance').isPlatformFinance(user);
  const allowed = isFinance || String(mp.payer) === String(user._id) || (leg === 'seller' && String(mp.recipient) === String(user._id));
  if (!allowed) throw fail('Receipt not found.', 404);
  const fileId = leg === 'commission' ? mp.commissionLeg?.file : mp.sellerLeg?.file;
  if (!fileId) throw fail('Receipt not found.', 404);
  return require('../models/PrivateFile').findById(fileId);
}

module.exports = { platformAccount, savePlatformAccount, quote, submit, confirmReceived, decide, adminList, mine, incoming, proof, PHONE };
