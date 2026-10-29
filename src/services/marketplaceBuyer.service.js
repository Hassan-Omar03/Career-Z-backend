const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const AppError = require('../utils/AppError');
const { notify, notifyAdmins } = require('./notification.service');
const flow = require('./marketplaceOrders.service');

// The buyer's own changes to an order (quantity, delivery details, cancelling), listing removal
// that keeps order history, and the seller's sales report.

const fail = (message, status = 422) => new AppError(message, status);
const ref = (o) => String(o._id).slice(-8).toUpperCase();
const physicalOf = (p) => !(p?.digital?.file || ['courses', 'services', 'notes'].includes(p?.category));

async function own(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id).populate('product', 'title stock status category digital price');
  if (!o || String(o.buyer) !== String(user._id)) throw fail('Order not found.', 404);
  return o;
}
async function openPayment(o) {
  return require('../models/ManualPayment').exists({ order: o._id, status: { $in: ['commission_submitted', 'commission_verified', 'submitted'] } });
}

// Quantity: only before paying (the amount to pay changes with it).
async function changeQuantity(user, id, quantity) {
  const o = await own(user, id);
  const q = Number(quantity);
  if (!Number.isInteger(q) || q < 1 || q > 100) throw fail('Choose a quantity from 1 to 100.');
  if (o.paymentStatus !== 'pending' || o.status !== 'pending') throw fail('The quantity can be changed only before you pay.', 409);
  if (await openPayment(o)) throw fail('CareerZ is checking your payment for this order; the quantity cannot change now.', 409);
  if (q === o.quantity) return o;
  const p = await Product.findById(o.product._id);
  if (physicalOf(p)) {
    const diff = q - o.quantity;
    if (diff > 0 && p.stock < diff) throw fail(`Only ${p.stock + o.quantity} available in total.`, 400);
    p.stock -= diff;
    p.status = p.stock <= 0 ? (p.status === 'active' ? 'out_of_stock' : p.status) : (p.status === 'out_of_stock' ? 'active' : p.status);
    await p.save();
  }
  flow.addStep(o, 'pending', user._id, `Quantity changed from ${o.quantity} to ${q}`);
  o.quantity = q;
  o.totalPrice = Math.round(o.unitPrice * q * 100) / 100;
  await o.save();
  await notify(o.seller, { title: `Order ${ref(o)}: quantity changed to ${q}`, category: 'marketplace' }).catch(() => {});
  return o;
}

// Delivery details: until the parcel leaves.
async function changeShipping(user, id, body) {
  const o = await own(user, id);
  if (!physicalOf(o.product)) throw fail('A digital order has no delivery address.', 409);
  if (!['pending', 'confirmed', 'processing'].includes(o.status)) throw fail('The parcel has already left; ask the seller in Messages.', 409);
  o.shipping = flow.shippingFrom(body, true);
  o.shippingAddress = flow.addressLine(o.shipping);
  flow.addStep(o, o.status, user._id, 'Delivery details updated');
  await o.save();
  await notify(o.seller, { title: `Order ${ref(o)}: new delivery details`, body: o.shippingAddress, category: 'marketplace' }).catch(() => {});
  return o;
}

// Cancel without waiting for the seller: unpaid orders any time; paid orders before the seller
// starts packing (CareerZ then refunds). Later on, the buyer asks the seller instead.
async function cancel(user, id, reason) {
  const o = await own(user, id);
  if (['cancelled', 'refunded', 'completed'].includes(o.status)) throw fail(`This order is already ${o.status}.`, 409);
  const text = String(reason || '').trim().slice(0, 300);
  if (o.paymentStatus === 'pending') {
    if (await openPayment(o)) throw fail('CareerZ is checking your payment for this order. Wait for the result, then cancel if you still want to.', 409);
  } else if (!['pending', 'confirmed'].includes(o.status) || o.escrow?.status !== 'held') {
    throw fail('The seller has already started on this order. Use "Ask to cancel" so the seller can agree, or open a dispute after delivery.', 409);
  }
  const wasPaid = o.paymentStatus === 'paid';
  if (wasPaid) o.escrow.status = 'refund_due';
  await flow.restock(o);
  flow.addStep(o, 'cancelled', user._id, text || 'Cancelled by the buyer');
  o.status = 'cancelled';
  o.cancellationRequested = false;
  await o.save();
  await notify(o.seller, { title: `Order ${ref(o)} cancelled by the buyer`, body: text || 'Do not send it.', category: 'marketplace' }).catch(() => {});
  if (wasPaid) await notifyAdmins({ title: `Refund due: order ${ref(o)}`, body: `The buyer cancelled a paid order before it was packed. Refund ${o.currency} ${o.totalPrice + (o.escrow.fee || 0)}.` }).catch(() => {});
  return o;
}

// Removing a listing keeps it for existing orders and reports; it just leaves the marketplace.
async function removeListing(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Listing not found.', 404);
  const p = await Product.findById(id);
  if (!p || String(p.seller) !== String(user._id) || p.status === 'removed') throw fail('Listing not found.', 404);
  const open = await Order.countDocuments({ product: p._id, status: { $nin: ['completed', 'cancelled', 'refunded'] }, $or: [{ paymentStatus: 'paid' }, { status: { $ne: 'pending' } }] });
  if (open) throw fail(`This listing has ${open} order${open === 1 ? '' : 's'} still in progress. Finish ${open === 1 ? 'it' : 'them'} first, or pause the listing.`, 409);
  const unpaid = await Order.find({ product: p._id, status: 'pending', paymentStatus: 'pending' });
  for (const o of unpaid) { o.status = 'cancelled'; flow.addStep(o, 'cancelled', user._id, 'The seller removed this listing'); await o.save(); await flow.tellBuyer(o, 'cancelled', 'The seller removed this item.'); }
  if (!(await Order.exists({ product: p._id }))) { await p.deleteOne(); return { deleted: true }; }
  p.status = 'removed';
  await p.save();
  return { removed: true };
}

// Seller report: per product (sold, revenue, cancelled, rating, views), the last 12 months and totals.
async function sellerReport(user) {
  const [products, orders, ratings] = await Promise.all([
    Product.find({ seller: user._id }).select('title category price currency stock status views createdAt').lean(),
    Order.find({ seller: user._id }).select('product quantity totalPrice currency status paymentStatus escrow createdAt').lean(),
    Review.aggregate([{ $match: { seller: user._id } }, { $group: { _id: '$product', avg: { $avg: '$rating' }, n: { $sum: 1 } } }])
  ]);
  const sold = (o) => o.paymentStatus === 'paid' && !['cancelled', 'refunded'].includes(o.status) && !['refund_due', 'refunded'].includes(o.escrow?.status);
  const rate = new Map(ratings.map((r) => [String(r._id), r]));
  const rows = products.map((p) => {
    const mine = orders.filter((o) => String(o.product) === String(p._id));
    const good = mine.filter(sold);
    return {
      _id: p._id, title: p.title, category: p.category, status: p.status, price: p.price, currency: p.currency, stock: p.stock, views: p.views || 0,
      orders: mine.length, unitsSold: good.reduce((s, o) => s + o.quantity, 0), revenue: good.reduce((s, o) => s + o.totalPrice, 0),
      cancelled: mine.filter((o) => ['cancelled', 'refunded'].includes(o.status)).length,
      rating: rate.get(String(p._id))?.avg ? Number(rate.get(String(p._id)).avg.toFixed(1)) : null, ratings: rate.get(String(p._id))?.n || 0,
      conversion: p.views ? Math.round(1000 * mine.length / p.views) / 10 : null
    };
  }).sort((a, b) => b.revenue - a.revenue || b.unitsSold - a.unitsSold);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const inMonth = orders.filter((o) => sold(o) && new Date(o.createdAt).toISOString().slice(0, 7) === key);
    months.push({ month: key, orders: inMonth.length, revenue: inMonth.reduce((s, o) => s + o.totalPrice, 0) });
  }
  const good = orders.filter(sold);
  return {
    totals: { orders: orders.length, paidOrders: good.length, unitsSold: good.reduce((s, o) => s + o.quantity, 0), revenue: good.reduce((s, o) => s + o.totalPrice, 0), cancelled: orders.filter((o) => ['cancelled', 'refunded'].includes(o.status)).length, listings: products.filter((p) => p.status !== 'removed').length },
    bestSeller: rows.find((r) => r.unitsSold > 0) || null,
    products: rows, months
  };
}

// The order's own message thread between its buyer and seller.
async function thread(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Order not found.', 404);
  const o = await Order.findById(id).select('buyer seller messages product').populate('product', 'title');
  const side = o && (String(o.buyer) === String(user._id) ? 'buyer' : String(o.seller) === String(user._id) ? 'seller' : null);
  if (!side) throw fail('Order not found.', 404);
  return { o, side };
}
async function messages(user, id) { const { o, side } = await thread(user, id); return { side, messages: o.messages || [] }; }
async function postMessage(user, id, text) {
  const { o, side } = await thread(user, id);
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) throw fail('Write a message.');
  o.messages = [...(o.messages || []), { from: side, text: t, at: new Date() }].slice(-200);
  await o.save();
  await notify(side === 'buyer' ? o.seller : o.buyer, { title: `Message about order ${ref(o)} (${o.product?.title || 'item'})`, body: t.slice(0, 200), link: side === 'buyer' ? '/dashboard?ws=marketplace_seller&tab=orders' : '/my-orders', category: 'marketplace' }, { email: side === 'seller' }).catch(() => {});
  return { side, messages: o.messages };
}

module.exports = { messages, postMessage, changeQuantity, changeShipping, cancel, removeListing, sellerReport };
