const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const PrivateFile = require('../models/PrivateFile');
const AppError = require('../utils/AppError');
const { notify, notifyAdmins } = require('./notification.service');

// Master 16B: Secure Escrow, Triple Verification, Digital Rights Protection, Delivery OTP,
// Buyer/Seller protection (disputes) and the Seller reputation score.
//   Escrow: the buyer pays the whole amount to CareerZ; it is held until
//     1. the buyer presses "Confirm received", or
//     2. the seller enters the buyer's delivery code (OTP) when handing the item over, or
//     3. nobody objects: AUTO_RELEASE_DAYS after delivery (physical) or after the buyer first
//        opened the file (digital, proven by the access log).
//   A dispute freezes the money until a CareerZ admin decides: release to the seller or refund.

const fail = (message, status = 422) => new AppError(message, status);
const oid = (id) => mongoose.isValidObjectId(id);
const AUTO_RELEASE_DAYS = 7;
const DIGITAL_RELEASE_DAYS = 3;
const ref = (o) => String(o._id).slice(-8).toUpperCase();
const ORDERS_LINK = '/dashboard?tab=marketplace';

const isDigital = (product) => Boolean(product?.digital?.file);
// Every step goes on the order's timeline (tracking).
const step = (o, status, note, by = null) => { o.timeline = [...(o.timeline || []), { status, at: new Date(), by, note }].slice(-40); };

// Called when CareerZ approves the buyer's receipt (inside the payment approval).
async function hold(orderId, paidTotal, session) {
  const order = await Order.findById(orderId).populate('product', 'title digital').session(session);
  if (!order || order.paymentStatus !== 'pending') throw fail('This order is no longer waiting for payment.', 409);
  const digital = isDigital(order.product);
  order.paymentStatus = 'paid';
  order.escrow = { status: 'held', amount: order.totalPrice, fee: Math.max(0, Math.round((paidTotal - order.totalPrice) * 100) / 100), heldAt: new Date() };
  if (!digital) order.deliveryCode = String(crypto.randomInt(100000, 999999));
  order.timeline = [...(order.timeline || []), { status: 'paid', at: new Date(), note: 'Payment confirmed; CareerZ holds it until delivery' }].slice(-40);
  await order.save({ session });
  return order;
}
// After the approval commits: tell both sides.
async function tellPaid(order) {
  const title = order.product?.title || 'your item';
  if (isDigital(order.product)) {
    await notify(order.buyer, { title: `Payment confirmed: ${title}`, body: 'Your file is ready in My Orders. CareerZ holds the payment until you confirm it is what you bought.', link: ORDERS_LINK, category: 'marketplace' }, { email: true }).catch(() => {});
  } else {
    await notify(order.buyer, { title: `Payment confirmed: ${title}. Your delivery code is ${order.deliveryCode}`, body: 'Give this code to the seller only when you have the item in your hands. CareerZ holds the payment until then.', link: ORDERS_LINK, category: 'marketplace' }, { email: true }).catch(() => {});
  }
  await notify(order.seller, { title: `Paid order ${ref(order)}: ${title}`, body: `CareerZ holds ${order.currency} ${order.totalPrice} for you. ${isDigital(order.product) ? 'The buyer can open the file now.' : 'Send the item and enter the buyer\'s delivery code when you hand it over.'} The money is released to your wallet after delivery.`, link: '/dashboard?ws=marketplace_seller&tab=orders', category: 'marketplace' }).catch(() => {});
}

async function release(order, by) {
  if (order.escrow?.status !== 'held') return order;
  order.escrow.status = 'released';
  order.escrow.releasedAt = new Date();
  order.escrow.releasedBy = by;
  if (!order.deliveredAt) order.deliveredAt = new Date();
  order.status = 'completed';
  order.timeline = [...(order.timeline || []), { status: 'completed', at: new Date(), note: { buyer: 'Buyer confirmed receipt', otp: 'Delivered with the buyer\'s code', auto: 'No problem reported in time', admin: 'CareerZ decided the dispute' }[by] || '' }].slice(-40);
  await order.save();
  await notify(order.seller, { title: `Payment released: ${order.currency} ${order.totalPrice} (order ${ref(order)})`, body: 'It is now in your available balance; withdraw it from Withdrawals.', category: 'marketplace' }).catch(() => {});
  return order;
}

// Rule 3: nobody objected in time. Runs whenever orders are loaded (no scheduler needed).
async function autoRelease(filter = {}) {
  const now = Date.now();
  const held = await Order.find({ ...filter, 'escrow.status': 'held' }).populate('product', 'digital');
  for (const o of held) {
    const digital = isDigital(o.product);
    const firstOpen = (o.accessLog || [])[0]?.at;
    const due = digital ? firstOpen && now - new Date(firstOpen).getTime() > DIGITAL_RELEASE_DAYS * 864e5
      : o.deliveredAt && now - new Date(o.deliveredAt).getTime() > AUTO_RELEASE_DAYS * 864e5;
    if (due) await release(o, 'auto');
  }
}

async function buyerOrder(user, id) {
  if (!oid(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id).populate('product', 'title digital category');
  if (!o || String(o.buyer) !== String(user._id)) throw fail('Order not found.', 404);
  return o;
}
async function sellerOrder(user, id) {
  if (!oid(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id).populate('product', 'title digital category');
  if (!o || String(o.seller) !== String(user._id)) throw fail('Order not found.', 404);
  return o;
}

// 1. Buyer: "Confirm received".
async function confirmReceived(user, id) {
  const o = await buyerOrder(user, id);
  if (o.escrow?.status !== 'held') throw fail(o.escrow?.status === 'disputed' ? 'This order is in a dispute; CareerZ will decide.' : 'There is no held payment on this order.', 409);
  return release(o, 'buyer');
}

// 2. Seller hands the item over and enters the buyer's delivery code.
async function deliverWithCode(user, id, code) {
  const o = await Order.findById(oid(id) ? id : null).select('+deliveryCode').populate('product', 'title digital');
  if (!o || String(o.seller) !== String(user._id)) throw fail('Order not found.', 404);
  if (o.escrow?.status !== 'held') throw fail('There is no held payment on this order.', 409);
  if (!o.deliveryCode) throw fail('This order has no delivery code.', 409);
  const tries = (o.deliveryCodeTries || 0) + 1;
  if (tries > 5) throw fail('Too many wrong codes. Ask the buyer to press "Confirm received" instead.', 429);
  if (String(code || '').trim() !== o.deliveryCode) { o.deliveryCodeTries = tries; await o.save(); throw fail('The delivery code is wrong. Ask the buyer for the 6-digit code in their order.'); }
  o.deliveredAt = new Date();
  o.deliveredVia = 'otp';
  step(o, 'delivered', 'Handed over; the buyer\'s delivery code was correct', user._id);
  await o.save();
  await notify(o.buyer, { title: `Delivered: ${o.product?.title || 'your order'}`, body: 'The seller confirmed delivery with your code.', link: ORDERS_LINK, category: 'marketplace' }).catch(() => {});
  return release(o, 'otp');
}

// Seller status changes on an escrow order (used by the order status endpoint).
async function onSellerStatus(order, status) {
  if (!order.escrow?.status) return;
  if (['completed', 'refunded'].includes(status)) throw fail(status === 'completed' ? 'The order completes itself when the payment is released (buyer confirms, delivery code, or after 7 days).' : 'Refunds of a paid order are made by CareerZ.', 403);
  if (status === 'delivered' && !order.deliveredAt) { order.deliveredAt = new Date(); order.deliveredVia = 'seller'; }
  if (status === 'cancelled' && ['held', 'disputed'].includes(order.escrow.status)) {
    order.escrow.status = 'refund_due';
    await notifyAdmins({ title: `Refund due: order ${ref(order)}`, body: `The seller cancelled a paid order. Refund ${order.currency} ${order.totalPrice + (order.escrow.fee || 0)} to the buyer.` }).catch(() => {});
  }
}

// ---------------------------------------------------------------- disputes (buyer & seller protection)
async function storeEvidence(file, owner) {
  if (!file?.data) return null;
  const m = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(file.data));
  if (!m) throw fail('Evidence must be a PDF, PNG, JPG or WEBP file.');
  const data = Buffer.from(m[3], 'base64');
  if (data.length > 3 * 1024 * 1024) throw fail('Each evidence file must be 3 MB or smaller.');
  return (await PrivateFile.create({ purpose: 'dispute_evidence', owner, filename: String(file.name || 'evidence').slice(0, 160), mimeType: m[1], size: data.length, data }))._id;
}

async function openDispute(user, id, { reason, note, file } = {}) {
  const o = await buyerOrder(user, id);
  if (o.escrow?.status !== 'held') throw fail(o.escrow?.status === 'disputed' ? 'A dispute is already open.' : 'You can open a dispute only while CareerZ is holding the payment.', 409);
  const text = String(reason || '').trim().slice(0, 1500);
  if (text.length < 15) throw fail('Explain what is wrong (not received, damaged, not as described…).');
  o.escrow.status = 'disputed';
  o.dispute = { open: true, reason: text, openedAt: new Date(), evidence: [{ by: 'buyer', note: String(note || '').trim().slice(0, 1000), file: await storeEvidence(file, user._id), at: new Date() }] };
  step(o, 'dispute', `Dispute opened: ${text.slice(0, 200)}`, user._id);
  await o.save();
  await notify(o.seller, { title: `Dispute opened on order ${ref(o)}`, body: `${text.slice(0, 200)} — add your side and evidence in Orders.`, link: '/dashboard?ws=marketplace_seller&tab=orders', category: 'marketplace' }).catch(() => {});
  await notifyAdmins({ title: `Marketplace dispute: order ${ref(o)}`, body: text.slice(0, 200) }).catch(() => {});
  return o;
}

async function addEvidence(user, id, { note, file } = {}) {
  if (!oid(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id);
  if (!o) throw fail('Order not found.', 404);
  const side = String(o.buyer) === String(user._id) ? 'buyer' : String(o.seller) === String(user._id) ? 'seller' : null;
  if (!side) throw fail('Order not found.', 404);
  if (!o.dispute?.open) throw fail('There is no open dispute on this order.', 409);
  const text = String(note || '').trim().slice(0, 1000);
  if (text.length < 5 && !file?.data) throw fail('Write your evidence or attach a file.');
  o.dispute.evidence.push({ by: side, note: text, file: await storeEvidence(file, user._id), at: new Date() });
  await o.save();
  return o;
}

async function evidenceFile(user, id, index, isAdmin) {
  if (!oid(id)) throw fail('Not found.', 404);
  const o = await Order.findById(id).lean();
  if (!o || (!isAdmin && String(o.buyer) !== String(user._id) && String(o.seller) !== String(user._id))) throw fail('Not found.', 404);
  const fileId = o.dispute?.evidence?.[Number(index)]?.file;
  const file = fileId ? await PrivateFile.findById(fileId) : null;
  if (!file) throw fail('Not found.', 404);
  return file;
}

// Admin decides a dispute: release to the seller, or refund the buyer (then record the transfer).
async function decideDispute(admin, id, { decision, note }) {
  if (!oid(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id).populate('product', 'title');
  if (!o?.dispute?.open) throw fail('No open dispute on this order.', 404);
  if (!['release', 'refund'].includes(decision)) throw fail('Choose release or refund.');
  const text = String(note || '').trim().slice(0, 1000);
  if (!text) throw fail('Write the reason; both sides see it.');
  Object.assign(o.dispute, { open: false, decision, decidedBy: admin._id, decidedAt: new Date(), note: text });
  step(o, 'dispute', `CareerZ decided: ${decision === 'release' ? 'pay the seller' : 'refund the buyer'}. ${text}`.slice(0, 300), admin._id);
  if (decision === 'release') { o.escrow.status = 'held'; await o.save(); await release(o, 'admin'); }
  else { o.escrow.status = 'refund_due'; await o.save(); }
  const msg = decision === 'release' ? 'CareerZ released the payment to the seller.' : `CareerZ will refund ${o.currency} ${o.totalPrice + (o.escrow.fee || 0)} to the buyer.`;
  for (const id2 of [o.buyer, o.seller]) await notify(id2, { title: `Dispute decided: order ${ref(o)}`, body: `${msg} ${text}`, category: 'marketplace' }, { email: true }).catch(() => {});
  return o;
}

// Admin records the refund transfer to the buyer.
async function markRefunded(admin, id, { reference }) {
  if (!oid(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id);
  if (o?.escrow?.status !== 'refund_due') throw fail('No refund is due on this order.', 409);
  const r = String(reference || '').trim().slice(0, 80);
  if (r.length < 4) throw fail('Enter the transaction ID of the refund transfer.');
  Object.assign(o.escrow, { status: 'refunded', refundedAt: new Date(), refundRef: r });
  step(o, 'refunded', `Refund sent to the buyer, transaction ${r}`, admin._id);
  o.status = 'refunded';
  o.paymentStatus = 'refunded';
  await o.save();
  await notify(o.buyer, { title: `Refund sent: ${o.currency} ${o.totalPrice + (o.escrow.fee || 0)} (order ${ref(o)})`, body: `Transaction ${r}.`, category: 'marketplace' }, { email: true }).catch(() => {});
  return o;
}

async function adminEscrow() {
  await autoRelease();
  const rows = await Order.find({ 'escrow.status': { $in: ['held', 'disputed', 'refund_due'] } }).populate('product', 'title').populate('buyer', 'fullName email phone').populate('seller', 'fullName email phone').sort({ updatedAt: -1 }).limit(200).lean();
  const totals = rows.reduce((t, o) => { t[o.escrow.status] = (t[o.escrow.status] || 0) + o.totalPrice; return t; }, {});
  return { rows, totals };
}

// ---------------------------------------------------------------- digital products (SDRPS)
const PDF = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/;
async function storeDigitalFile(file, owner) {
  const m = PDF.exec(String(file?.data || ''));
  if (!m) throw fail('Upload the digital product as a PDF file.');
  const data = Buffer.from(m[1], 'base64');
  if (data.length > 12 * 1024 * 1024) throw fail('The PDF must be 12 MB or smaller.');
  try { await require('pdf-lib').PDFDocument.load(data, { ignoreEncryption: true }); } catch { throw fail('This PDF could not be read.'); }
  return (await PrivateFile.create({ purpose: 'digital_product', owner, filename: String(file.name || 'file.pdf').replace(/[\\/]/g, '_').slice(0, 160), mimeType: 'application/pdf', size: data.length, data }))._id;
}

async function stamp(buffer, lines, { preview = false } = {}) {
  const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  let doc = src;
  if (preview) {
    doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, src.getPageIndices().slice(0, Math.min(3, src.getPageCount())));
    pages.forEach((p) => doc.addPage(p));
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const big = preview ? 'PREVIEW · CareerZ' : lines[0];
    page.drawText(big, { x: width * 0.12, y: height * 0.35, size: Math.max(18, Math.min(width / 14, 42)), font, color: rgb(0.6, 0.6, 0.6), opacity: 0.18, rotate: degrees(35) });
    page.drawText(lines.join('  ·  '), { x: 24, y: 14, size: 7.5, font, color: rgb(0.35, 0.35, 0.35), opacity: 0.85 });
  }
  if (preview && src.getPageCount() > 3) {
    const last = doc.addPage();
    const { width, height } = last.getSize();
    last.drawText(`Preview ends here — ${src.getPageCount() - 3} more page(s) after purchase on CareerZ.`, { x: 40, y: height / 2, size: 14, font, color: rgb(0.2, 0.2, 0.2), maxWidth: width - 80 });
  }
  doc.setTitle(preview ? 'Preview' : 'Purchased file');
  return Buffer.from(await doc.save());
}

// Public: the first pages, stamped PREVIEW.
// Live listings for everyone; a listing under review for its seller and CareerZ admins.
async function previewFile(productId, user) {
  if (!oid(productId)) throw fail('Not found.', 404);
  const staff = (user?.roles || []).some((r) => ['admin', 'super_admin', 'platform_staff'].includes(r));
  const p = await Product.findOne({ _id: productId, ...(staff ? {} : { $or: [{ status: 'active' }, ...(user ? [{ seller: user._id }] : [])] }) }).select('digital title');
  const file = p?.digital?.file ? await PrivateFile.findById(p.digital.file) : null;
  if (!file) throw fail('No preview for this listing.', 404);
  return { filename: `Preview - ${p.title}.pdf`.replace(/[^\w .-]/g, '_'), data: await stamp(file.data, ['Preview'], { preview: true }) };
}

// Buyer: the full file with their name, ID and purchase date on every page; every open is logged.
async function purchasedFile(user, orderId, mode, meta = {}) {
  const o = await buyerOrder(user, orderId);
  if (!isDigital(o.product)) throw fail('This order is not a digital product.', 409);
  if (o.paymentStatus !== 'paid' || ['refund_due', 'refunded'].includes(o.escrow?.status) || o.status === 'refunded') throw fail('The file opens once your payment is confirmed.', 403);
  const wanted = mode === 'download' ? 'download' : 'view';
  if (wanted === 'download' && o.product.digital.access === 'online') throw fail('The seller allows this file to be read online only.', 403);
  const file = await PrivateFile.findById(o.product.digital.file);
  if (!file) throw fail('The seller removed this file. Open a dispute for a refund.', 410);
  const when = new Date(o.escrow?.heldAt || o.createdAt).toISOString().slice(0, 10);
  const data = await stamp(file.data, [`Licensed to ${user.fullName}`, `User ID ${user._id}`, `Purchased ${when}`, `Order ${ref(o)}`, 'CareerZ — do not share']);
  o.accessLog = [...(o.accessLog || []), { action: wanted, at: new Date(), ip: String(meta.ip || '').slice(0, 64) }].slice(-50);
  await o.save();
  return { filename: file.filename, data, inline: wanted === 'view' };
}

// ---------------------------------------------------------------- Seller Trust Score (16B.16)
async function sellerTrust(sellerId) {
  if (!oid(sellerId)) throw fail('Seller not found.', 404);
  const [ratingAgg, orders, said] = await Promise.all([
    Review.aggregate([{ $match: { seller: new mongoose.Types.ObjectId(String(sellerId)) } }, { $group: { _id: null, avg: { $avg: { $ifNull: ['$sellerRating', '$rating'] } }, n: { $sum: 1 } } }]),
    Order.find({ seller: sellerId, paymentStatus: { $in: ['paid', 'refunded'] } }).select('status escrow dispute deliveredAt createdAt refundRequested').lean(),
    Review.find({ seller: sellerId, deliveredOnTime: { $ne: null } }).select('deliveredOnTime').lean()
  ]);
  const avg = ratingAgg[0]?.avg ?? null, reviews = ratingAgg[0]?.n || 0;
  const paid = orders.length;
  const delivered = orders.filter((o) => o.deliveredAt || ['delivered', 'completed'].includes(o.status));
  const onTime = delivered.filter((o) => o.deliveredAt && o.escrow?.heldAt && new Date(o.deliveredAt) - new Date(o.escrow.heldAt) <= AUTO_RELEASE_DAYS * 864e5).length;
  const disputes = orders.filter((o) => o.dispute?.reason).length;
  const lost = orders.filter((o) => o.dispute?.decision === 'refund').length;
  const refunds = orders.filter((o) => o.status === 'refunded').length;
  const factors = [
    { key: 'rating', label: 'Rating', max: 35, hasData: reviews > 0, points: reviews ? Math.round(35 * avg / 5) : 0, value: reviews ? `${avg.toFixed(1)} / 5 from ${reviews} review${reviews === 1 ? '' : 's'}` : 'No reviews yet' },
    (() => {
      const measured = delivered.length ? onTime / delivered.length : null;
      const told = said.length ? said.filter((r) => r.deliveredOnTime).length / said.length : null;
      const parts = [measured, told].filter((x) => x !== null);
      const rate = parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : 0;
      const value = !parts.length ? 'No deliveries yet' : [measured !== null && `${Math.round(100 * measured)}% delivered within ${AUTO_RELEASE_DAYS} days`, told !== null && `${Math.round(100 * told)}% of ${said.length} buyer${said.length === 1 ? '' : 's'} say on time`].filter(Boolean).join(' · ');
      return { key: 'delivery', label: 'Delivery performance', max: 25, hasData: parts.length > 0, points: Math.round(25 * rate), value };
    })(),
    { key: 'complaints', label: 'Complaint ratio', max: 25, hasData: paid > 0, points: paid ? Math.round(25 * Math.max(0, 1 - (disputes / paid) * 4)) : 0, value: paid ? `${disputes} dispute${disputes === 1 ? '' : 's'} in ${paid} order${paid === 1 ? '' : 's'}` : 'No orders yet' },
    { key: 'refunds', label: 'Refunds & lost disputes', max: 15, hasData: paid > 0, points: paid ? Math.round(15 * Math.max(0, 1 - ((refunds + lost) / paid) * 4)) : 0, value: paid ? `${refunds} refunded, ${lost} dispute${lost === 1 ? '' : 's'} lost` : 'No orders yet' }
  ];
  const counted = factors.filter((f) => f.hasData);
  const max = counted.reduce((s, f) => s + f.max, 0);
  const score = max ? Math.round(100 * counted.reduce((s, f) => s + f.points, 0) / max) : null;
  return { score, level: score === null ? 'New seller' : score >= 80 ? 'Trusted seller' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Low', factors, orders: paid, reviews, rating: avg === null ? null : Number(avg.toFixed(1)) };
}

module.exports = {
  AUTO_RELEASE_DAYS, DIGITAL_RELEASE_DAYS, isDigital, hold, tellPaid, release, autoRelease, confirmReceived, deliverWithCode, onSellerStatus,
  openDispute, addEvidence, evidenceFile, decideDispute, markRefunded, adminEscrow, storeDigitalFile, previewFile, purchasedFile, sellerTrust
};
