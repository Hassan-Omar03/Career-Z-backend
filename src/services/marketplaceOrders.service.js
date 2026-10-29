const Order = require('../models/Order');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { notify } = require('./notification.service');

// Order details the seller needs to send a parcel, the order timeline and shipment tracking,
// stock release for cancelled/unpaid orders, and buyer notifications on every step.

const fail = (message, status = 422) => new AppError(message, status);
const UNPAID_DAYS = 3;
const PHONE = /^(\+92|0)?3\d{2}[-\s]?\d{7}$|^\+?\d[\d\s-]{8,16}$/;
const CNIC = /^\d{5}-?\d{7}-?\d$/;
const ref = (o) => String(o._id).slice(-8).toUpperCase();

// A physical parcel needs the receiver's full details; a digital file needs none.
function shippingFrom(body = {}, physical) {
  const s = body.shipping || {};
  const clean = (v, n) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);
  const out = {
    name: clean(s.name, 80), phone: clean(s.phone, 20), cnic: clean(s.cnic, 15), address: clean(s.address, 300),
    city: clean(s.city, 60), province: clean(s.province, 60), postalCode: clean(s.postalCode, 12), landmark: clean(s.landmark, 160), locationUrl: clean(s.locationUrl, 300)
  };
  if (!physical) return out;
  if (out.name.length < 3) throw fail('Enter the full name of the person receiving the parcel.');
  if (!PHONE.test(out.phone)) throw fail('Enter a working phone number for the courier, e.g. 03001234567.');
  if (!CNIC.test(out.cnic)) throw fail('Enter the receiver\'s CNIC number (13 digits, e.g. 35202-1234567-1).');
  if (out.address.length < 10) throw fail('Enter the full delivery address: house, street, area.');
  if (out.city.length < 2) throw fail('Enter the city.');
  if (out.locationUrl && !/^https:\/\//.test(out.locationUrl)) throw fail('The location link must start with https:// (e.g. a Google Maps link).');
  if (out.cnic.length === 13) out.cnic = `${out.cnic.slice(0, 5)}-${out.cnic.slice(5, 12)}-${out.cnic.slice(12)}`;
  return out;
}
const addressLine = (s) => [s.address, s.landmark, s.city, s.province, s.postalCode].filter(Boolean).join(', ');

const STEP_TEXT = {
  pending: 'Order placed', confirmed: 'Seller confirmed the order', processing: 'Seller is preparing the order', shipped: 'Parcel shipped',
  delivered: 'Marked delivered', completed: 'Completed: payment released to the seller', cancelled: 'Order cancelled', refunded: 'Refunded'
};
function addStep(order, status, by, note = '') {
  order.timeline = [...(order.timeline || []), { status, at: new Date(), by, note: String(note || '').slice(0, 300) }].slice(-40);
}
async function tellBuyer(order, status, extra = '') {
  const title = `Order ${ref(order)}: ${STEP_TEXT[status] || status}`;
  await notify(order.buyer, { title, body: extra, link: '/my-orders', category: 'marketplace' }, { email: true }).catch(() => {});
}

// Seller status rules on a paid (escrow) order: nothing ships before payment, shipping needs a
// courier and tracking number (or "own delivery").
function checkSellerStep(order, status, body = {}) {
  const physical = !order.product?.digital?.fileName;
  if (['confirmed', 'processing', 'shipped', 'delivered'].includes(status) && order.paymentStatus !== 'paid') throw fail('Wait until CareerZ confirms the buyer\'s payment before you confirm, pack or ship the order.', 409);
  if (status === 'shipped' && physical) {
    const courier = String(body.courier || '').trim().slice(0, 60);
    const trackingNo = String(body.trackingNo || '').trim().slice(0, 60);
    if (!courier) throw fail('Choose the courier (or "Own delivery").');
    if (courier !== 'Own delivery' && trackingNo.length < 4) throw fail('Enter the courier tracking number so the buyer can follow the parcel.');
    const trackingUrl = String(body.trackingUrl || '').trim().slice(0, 300);
    if (trackingUrl && !/^https:\/\//.test(trackingUrl)) throw fail('The tracking link must start with https://.');
    order.shipment = { courier, trackingNo, trackingUrl, shippedAt: new Date() };
  }
}

// Stock comes back when an order is cancelled.
async function restock(order) {
  if (order.stockReturned) return;
  const product = await Product.findById(order.product?._id || order.product).select('stock status category digital');
  if (!product || product.digital?.file || ['courses', 'services', 'notes'].includes(product.category)) return;
  product.stock += order.quantity;
  if (product.status === 'out_of_stock' && product.stock > 0) product.status = 'active';
  await product.save();
  order.stockReturned = true;
}

// Orders not paid within UNPAID_DAYS are cancelled so the stock is free again.
async function expireUnpaid(filter = {}) {
  const old = await Order.find({ ...filter, paymentStatus: 'pending', status: 'pending', createdAt: { $lt: new Date(Date.now() - UNPAID_DAYS * 864e5) } });
  const ManualPayment = require('../models/ManualPayment');
  for (const o of old) {
    if (await ManualPayment.exists({ order: o._id, status: { $in: ['commission_submitted', 'commission_verified', 'submitted'] } })) continue; // a receipt is being checked
    o.status = 'cancelled';
    addStep(o, 'cancelled', null, `Not paid within ${UNPAID_DAYS} days`);
    await restock(o);
    await o.save();
    await tellBuyer(o, 'cancelled', `It was not paid within ${UNPAID_DAYS} days. You can order again any time.`);
  }
}

module.exports = { UNPAID_DAYS, shippingFrom, addressLine, addStep, tellBuyer, checkSellerStep, restock, expireUnpaid, STEP_TEXT };
