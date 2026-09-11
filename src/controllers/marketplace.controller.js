const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const RoleRequest = require('../models/RoleRequest');
const Message = require('../models/Message');
const Setting = require('../models/Setting');
const Notification = require('../models/Notification');
const SellerWithdrawal = require('../models/SellerWithdrawal');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('../services/notification.service');

const LOW_STOCK_THRESHOLD = 5;
// "courses" and "services" are digital — stock tracking doesn't apply to them (item 8: "Digital
// product/service mein stock system optional hoga").
const DIGITAL_CATEGORIES = ['courses', 'services'];
const isPhysical = (product) => !DIGITAL_CATEGORIES.includes(product.category);

const COMMISSION_RATE_KEY = 'marketplace_commission_percent';
const DEFAULT_COMMISSION_RATE = 10;

function assertOwnsProduct(product, userId) {
  if (product.seller.toString() !== userId.toString()) {
    throw new AppError('You do not own this listing.', 403);
  }
}

// POST /api/marketplace/products — new listings start "pending_approval" (needs Super Admin
// review before going live) unless the seller explicitly saves it as a "draft" first.
const createProduct = asyncHandler(async (req, res) => {
  if (!(await isRoleVerified(req.user._id, 'marketplace_seller'))) {
    throw new AppError('Your Seller account is pending Super Admin verification. You can browse the dashboard but cannot list a product until it is approved.', 403);
  }

  const allowed = ['title', 'description', 'category', 'price', 'currency', 'stock', 'images'];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || body.price === undefined) {
    throw new AppError('title and price are required.', 422);
  }
  if (req.body.status === 'draft') body.status = 'draft';

  const product = await Product.create({ ...body, seller: req.user._id });
  return created(res, product, product.status === 'draft' ? 'Draft saved.' : 'Listing submitted for review.');
});

// GET /api/marketplace/products (public browse)
const listProducts = asyncHandler(async (req, res) => {
  const { q, category, maxPrice } = req.query;
  const filter = { status: 'active' };
  if (category) filter.category = category;
  if (maxPrice) filter.price = { $lte: Number(maxPrice) };
  if (q) filter.$text = { $search: q };

  const products = await Product.find(filter).populate('seller', 'fullName email').sort({ createdAt: -1 }).limit(100);
  return ok(res, products);
});

// GET /api/marketplace/products/:id — a real view counter, incremented atomically per request.
const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true }).populate('seller', 'fullName email');
  if (!product) throw new AppError('Listing not found.', 404);
  return ok(res, product);
});

// GET /api/marketplace/products/mine/list — includes real units-sold per listing (delivered/
// completed orders only, same "earned" definition used everywhere else in this dashboard).
const myProducts = asyncHandler(async (req, res) => {
  const products = await Product.find({ seller: req.user._id }).sort({ createdAt: -1 });
  const salesAgg = await Order.aggregate([
    { $match: { seller: req.user._id, status: { $in: ['delivered', 'completed'] } } },
    { $group: { _id: '$product', unitsSold: { $sum: '$quantity' } } }
  ]);
  const soldByProduct = Object.fromEntries(salesAgg.map((s) => [s._id.toString(), s.unitsSold]));
  const withSales = products.map((p) => ({ ...p.toObject(), totalSales: soldByProduct[p._id.toString()] || 0 }));
  return ok(res, withSales);
});

// GET /api/marketplace/sellers/mine/profile — Seller Dashboard item 1: store name/logo (User
// fields), verification (RoleRequest), rating/review count (computed live from real Review
// documents, never stored/stale), store status, and everything needed for profile completeness.
const mySellerProfile = asyncHandler(async (req, res) => {
  const [verification, ratingAgg, totalListings] = await Promise.all([
    RoleRequest.findOne({ user: req.user._id, requestedRole: 'marketplace_seller' }),
    Review.aggregate([
      { $match: { seller: req.user._id } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]),
    Product.countDocuments({ seller: req.user._id })
  ]);

  const rating = ratingAgg[0] ? Math.round(ratingAgg[0].avgRating * 10) / 10 : null;
  const totalReviews = ratingAgg[0]?.count || 0;

  return ok(res, {
    storeName: req.user.companyName || '',
    storeLogo: req.user.profilePhoto || null,
    verificationStatus: verification?.status || 'pending',
    sellerRating: rating,
    totalReviews,
    storeStatus: req.user.storeStatus,
    totalListings
  });
});

// GET /api/marketplace/sellers/mine/summary — Seller Dashboard item 2: 8 real summary cards.
// Money fields are grouped per currency (never summed across different currencies) — same
// pattern used for Donor/Agent. "Pending Orders" = confirmed/shipped (not yet delivered, not
// cancelled). Total Sales = gross value of every non-cancelled order; Total Earnings/Available
// Balance = only orders actually delivered (realized revenue) — there's no withdrawal system yet,
// so Available Balance equals Total Earnings until one exists; Pending Balance is what's still
// in-flight (confirmed/shipped, not yet delivered).
const mySellerSummary = asyncHandler(async (req, res) => {
  const [totalListings, activeListings, orders] = await Promise.all([
    Product.countDocuments({ seller: req.user._id }),
    Product.countDocuments({ seller: req.user._id, status: 'active' }),
    Order.find({ seller: req.user._id }).select('status totalPrice currency')
  ]);

  const pendingOrders = orders.filter((o) => ['pending', 'confirmed', 'processing', 'shipped'].includes(o.status)).length;
  const completedOrders = orders.filter((o) => ['delivered', 'completed'].includes(o.status)).length;

  const byCurrency = {};
  function bucket(currency) {
    if (!byCurrency[currency]) byCurrency[currency] = { totalSales: 0, totalEarnings: 0, availableBalance: 0, pendingBalance: 0 };
    return byCurrency[currency];
  }
  orders.forEach((o) => {
    if (o.status === 'cancelled') return;
    const b = bucket(o.currency);
    b.totalSales += o.totalPrice;
    if (o.status === 'delivered' || o.status === 'completed') {
      b.totalEarnings += o.totalPrice;
      b.availableBalance += o.totalPrice;
    } else if (['confirmed', 'processing', 'shipped'].includes(o.status)) {
      b.pendingBalance += o.totalPrice;
    }
    // refunded orders count toward totalSales (the sale really happened) but not toward earnings.
  });

  return ok(res, {
    totalListings,
    activeListings,
    pendingOrders,
    completedOrders,
    totalsByCurrency: byCurrency
  });
});

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = "no prior data to compare against"
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// GET /api/marketplace/sellers/mine/sales-overview — Seller Dashboard item 3. Revenue counts only
// delivered/completed orders (same "earned" definition as the summary cards); "Order count" is
// every order received regardless of status (raw volume, a separate lens from revenue). Rolling
// windows (last 24h / 7d / 30d) rather than calendar boundaries, to avoid partial-period skew.
// Per-currency, like every other money figure in this app.
const mySalesOverview = asyncHandler(async (req, res) => {
  const orders = await Order.find({ seller: req.user._id }).select('status totalPrice currency createdAt');
  const now = Date.now();
  const DAY = 86400000;
  const isEarned = (o) => o.status === 'delivered' || o.status === 'completed';

  const byCurrency = {};
  function bucket(currency) {
    if (!byCurrency[currency]) {
      byCurrency[currency] = {
        today: 0, yesterday: 0, thisWeek: 0, lastWeek: 0, thisMonth: 0, lastMonth: 0,
        totalRevenue: 0, orderCount: 0, dailySales: []
      };
    }
    return byCurrency[currency];
  }

  orders.forEach((o) => {
    const b = bucket(o.currency);
    b.orderCount += 1;
    if (!isEarned(o)) return;
    const age = now - new Date(o.createdAt).getTime();
    b.totalRevenue += o.totalPrice;
    if (age <= DAY) b.today += o.totalPrice;
    else if (age <= 2 * DAY) b.yesterday += o.totalPrice;
    if (age <= 7 * DAY) b.thisWeek += o.totalPrice;
    else if (age <= 14 * DAY) b.lastWeek += o.totalPrice;
    if (age <= 30 * DAY) b.thisMonth += o.totalPrice;
    else if (age <= 60 * DAY) b.lastMonth += o.totalPrice;
  });

  // Daily sales for the last 14 days, for the graph.
  Object.keys(byCurrency).forEach((currency) => {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const dayStart = now - i * DAY;
      const label = new Date(dayStart).toISOString().slice(0, 10);
      const total = orders
        .filter((o) => o.currency === currency && isEarned(o) && Math.floor((now - new Date(o.createdAt).getTime()) / DAY) === i)
        .reduce((sum, o) => sum + o.totalPrice, 0);
      days.push({ date: label, total });
    }
    byCurrency[currency].dailySales = days;
    byCurrency[currency].todayChangePct = pctChange(byCurrency[currency].today, byCurrency[currency].yesterday);
    byCurrency[currency].weekChangePct = pctChange(byCurrency[currency].thisWeek, byCurrency[currency].lastWeek);
    byCurrency[currency].monthChangePct = pctChange(byCurrency[currency].thisMonth, byCurrency[currency].lastMonth);
  });

  return ok(res, { totalsByCurrency: byCurrency });
});

// GET /api/marketplace/sellers/mine/pending-actions — Seller Dashboard item 6, seven real,
// independently-computed queues (nothing here is a fabricated placeholder count).
const myPendingActions = asyncHandler(async (req, res) => {
  const [
    newOrders, pendingApprovalProducts, lowStockProducts, ordersRequiringShipment,
    cancellationRequests, refundRequests, buyerIds
  ] = await Promise.all([
    Order.find({ seller: req.user._id, status: 'pending' }).populate('product', 'title').populate('buyer', 'fullName').sort({ createdAt: -1 }),
    Product.find({ seller: req.user._id, status: 'pending_approval' }).sort({ createdAt: -1 }),
    Product.find({ seller: req.user._id, status: 'active', stock: { $gt: 0, $lte: LOW_STOCK_THRESHOLD } }).sort({ stock: 1 }),
    Order.find({ seller: req.user._id, status: { $in: ['confirmed', 'processing'] } }).populate('product', 'title').populate('buyer', 'fullName').sort({ createdAt: -1 }),
    Order.find({ seller: req.user._id, cancellationRequested: true }).populate('product', 'title').populate('buyer', 'fullName').sort({ createdAt: -1 }),
    Order.find({ seller: req.user._id, refundRequested: true }).populate('product', 'title').populate('buyer', 'fullName').sort({ createdAt: -1 }),
    Order.find({ seller: req.user._id }).distinct('buyer')
  ]);

  // "Unanswered" = the most recent message in that thread is from the buyer and the seller
  // hasn't read it yet — computed from real Message documents, one row per buyer conversation.
  const unreadFromBuyers = buyerIds.length > 0
    ? await Message.find({ from: { $in: buyerIds }, to: req.user._id, read: false }).populate('from', 'fullName').sort({ createdAt: -1 })
    : [];
  const unansweredByBuyer = new Map();
  unreadFromBuyers.forEach((m) => { if (!unansweredByBuyer.has(m.from._id.toString())) unansweredByBuyer.set(m.from._id.toString(), m); });

  return ok(res, {
    newOrders,
    pendingApprovalProducts,
    lowStockProducts,
    ordersRequiringShipment,
    cancellationRequests,
    refundRequests,
    unansweredMessages: Array.from(unansweredByBuyer.values()).map((m) => ({ buyer: m.from, lastMessage: m.text, lastAt: m.createdAt }))
  });
});

// GET /api/marketplace/sellers/mine/returns-refunds — the full Returns & Refunds history: every
// order that ever had a cancellation/refund request, pending or resolved (unlike Pending Actions'
// subset, which only shows the still-open ones).
const myReturnsRefunds = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    seller: req.user._id,
    $or: [{ cancellationRequested: true }, { refundRequested: true }, { status: 'cancelled' }, { status: 'refunded' }]
  })
    .populate('product', 'title')
    .populate('buyer', 'fullName')
    .sort({ updatedAt: -1 });
  return ok(res, orders);
});

// GET /api/marketplace/sellers/mine/best-selling — Seller Dashboard item 7. Units sold + revenue
// from real delivered/completed orders only; rating is the live per-product average from Review
// documents (not the seller-wide rating used on item 1).
const myBestSellingProducts = asyncHandler(async (req, res) => {
  const sales = await Order.aggregate([
    { $match: { seller: req.user._id, status: { $in: ['delivered', 'completed'] } } },
    { $group: { _id: '$product', unitsSold: { $sum: '$quantity' }, totalRevenue: { $sum: '$totalPrice' }, currency: { $first: '$currency' } } },
    { $sort: { unitsSold: -1 } },
    { $limit: 10 }
  ]);
  if (sales.length === 0) return ok(res, []);

  const productIds = sales.map((s) => s._id);
  const [products, ratings] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).select('title stock currency'),
    Review.aggregate([
      { $match: { product: { $in: productIds } } },
      { $group: { _id: '$product', avgRating: { $avg: '$rating' } } }
    ])
  ]);
  const productById = Object.fromEntries(products.map((p) => [p._id.toString(), p]));
  const ratingByProduct = Object.fromEntries(ratings.map((r) => [r._id.toString(), Math.round(r.avgRating * 10) / 10]));

  const result = sales.map((s) => {
    const p = productById[s._id.toString()];
    return {
      productId: s._id,
      productName: p?.title || 'Deleted listing',
      unitsSold: s.unitsSold,
      totalRevenue: s.totalRevenue,
      currency: s.currency,
      currentStock: p?.stock ?? null,
      rating: ratingByProduct[s._id.toString()] ?? null
    };
  });

  return ok(res, result);
});

// GET /api/marketplace/sellers/mine/inventory — Seller Dashboard item 8. Physical listings only
// (courses/services are digital — stock tracking is optional/not applicable, so they're excluded
// here entirely rather than showing a misleading "0 stock").
const myInventory = asyncHandler(async (req, res) => {
  const products = await Product.find({ seller: req.user._id, category: { $nin: DIGITAL_CATEGORIES } })
    .select('title category stock status')
    .sort({ stock: 1 });

  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= LOW_STOCK_THRESHOLD);
  const outOfStock = products.filter((p) => p.status === 'out_of_stock' || p.stock === 0);

  return ok(res, {
    items: products,
    lowStock,
    outOfStock,
    lowStockThreshold: LOW_STOCK_THRESHOLD
  });
});

// Super Admin can configure a different commission percentage per product category (Important
// Rule: "Commission rules Super Admin category... ke mutabiq configure karega"). Institution/
// country-based rules aren't included — Product has no institution or country field to key off,
// so only the dimension that actually exists in this data model (category) is real here.
function categoryRateKey(category) { return `${COMMISSION_RATE_KEY}:${category}`; }

// GET /api/marketplace/commission-rate — any authenticated user can read it. Pass ?category= to
// get that category's override (falls back to the platform default if none is set).
const getCommissionRate = asyncHandler(async (req, res) => {
  const { category } = req.query;
  if (category) {
    const scoped = await Setting.findOne({ key: categoryRateKey(category) });
    if (scoped) return ok(res, { rate: scoped.value, category, isOverride: true });
  }
  const setting = await Setting.findOne({ key: COMMISSION_RATE_KEY });
  return ok(res, { rate: setting ? setting.value : DEFAULT_COMMISSION_RATE, category: category || null, isOverride: false });
});

// PATCH /api/marketplace/commission-rate — Super Admin only. Pass `category` to set a per-category
// override instead of the platform-wide default.
const setCommissionRate = asyncHandler(async (req, res) => {
  const { rate, category } = req.body;
  if (typeof rate !== 'number' || rate < 0 || rate > 100) throw new AppError('rate must be a number between 0 and 100.', 422);
  const key = category ? categoryRateKey(category) : COMMISSION_RATE_KEY;
  const setting = await Setting.findOneAndUpdate({ key }, { key, value: rate }, { new: true, upsert: true });
  return ok(res, { rate: setting.value, category: category || null }, `Marketplace commission rate updated${category ? ` for ${category}` : ''}.`);
});

// GET /api/marketplace/sellers/mine/earnings — Seller Dashboard item 9. CareerZ's commission is
// deducted automatically from realized (delivered/completed) sales, per-order at whatever
// category-specific (or platform-default) percentage Super Admin has set. "Payment charges" is
// honestly 0 — no real payment processor is integrated in this app, so there are no real processor
// fees to report yet.
// Shared by myEarnings (item 9) and myWallet (item 10) so both show the same numbers for the
// same real-world quantity — never two different "available balance" figures in one dashboard.
async function computeEarnings(sellerId) {
  const [orders, allRateSettings, withdrawals] = await Promise.all([
    Order.find({ seller: sellerId }).populate('product', 'category').select('status totalPrice currency product'),
    Setting.find({ key: { $regex: `^${COMMISSION_RATE_KEY}` } }),
    SellerWithdrawal.find({ seller: sellerId, status: { $ne: 'rejected' } }).select('amount currency status')
  ]);

  const defaultRate = allRateSettings.find((s) => s.key === COMMISSION_RATE_KEY)?.value ?? DEFAULT_COMMISSION_RATE;
  const rateByCategory = {};
  allRateSettings.forEach((s) => {
    if (s.key !== COMMISSION_RATE_KEY) rateByCategory[s.key.slice(COMMISSION_RATE_KEY.length + 1)] = s.value;
  });
  const rateForOrder = (o) => {
    const category = o.product?.category;
    return category && rateByCategory[category] !== undefined ? rateByCategory[category] : defaultRate;
  };

  const byCurrency = {};
  function bucket(currency) {
    if (!byCurrency[currency]) byCurrency[currency] = { grossSales: 0, earnedGross: 0, platformCommission: 0, refundDeductions: 0, pendingEarnings: 0, withdrawnOrPending: 0 };
    return byCurrency[currency];
  }
  orders.forEach((o) => {
    if (o.status === 'cancelled') return;
    const b = bucket(o.currency);
    b.grossSales += o.totalPrice;
    if (o.status === 'delivered' || o.status === 'completed') {
      b.earnedGross += o.totalPrice;
      b.platformCommission += Math.round(o.totalPrice * (rateForOrder(o) / 100) * 100) / 100;
    } else if (o.status === 'refunded') b.refundDeductions += o.totalPrice;
    else if (['confirmed', 'processing', 'shipped'].includes(o.status)) b.pendingEarnings += o.totalPrice;
  });
  withdrawals.forEach((w) => { bucket(w.currency).withdrawnOrPending += w.amount; });

  Object.values(byCurrency).forEach((b) => {
    b.platformCommission = Math.round(b.platformCommission * 100) / 100;
    b.paymentCharges = 0; // no real payment processor integrated yet
    b.netEarnings = Math.round((b.earnedGross - b.platformCommission - b.paymentCharges - b.refundDeductions) * 100) / 100;
    // Available = net earnings minus anything already withdrawn or awaiting withdrawal.
    b.availableEarnings = Math.max(Math.round((b.netEarnings - b.withdrawnOrPending) * 100) / 100, 0);
  });

  return { commissionRate: defaultRate, categoryRates: rateByCategory, totalsByCurrency: byCurrency };
}

const myEarnings = asyncHandler(async (req, res) => {
  const result = await computeEarnings(req.user._id);
  return ok(res, result);
});

// GET /api/marketplace/sellers/mine/wallet — Seller Dashboard item 10. Reuses the exact same
// earnings computation as item 9 (never a second, conflicting "available balance" number).
const myWallet = asyncHandler(async (req, res) => {
  const { totalsByCurrency } = await computeEarnings(req.user._id);
  const wallet = {};
  Object.entries(totalsByCurrency).forEach(([currency, b]) => {
    wallet[currency] = { availableBalance: b.availableEarnings, pendingBalance: b.pendingEarnings, totalEarnings: b.netEarnings };
  });
  return ok(res, wallet);
});

// POST /api/marketplace/sellers/mine/withdraw — requests the full available balance in one
// currency, same "no real payment processor" honesty as the Agent's withdrawal flow: this creates
// a real, trackable request, not a fake instant payout.
const requestSellerWithdrawal = asyncHandler(async (req, res) => {
  const { currency } = req.body;
  if (!currency) throw new AppError('currency is required.', 422);

  const { totalsByCurrency } = await computeEarnings(req.user._id);
  const available = totalsByCurrency[currency]?.availableEarnings || 0;
  if (available <= 0) throw new AppError('No available balance in that currency.', 422);

  const withdrawal = await SellerWithdrawal.create({ seller: req.user._id, amount: available, currency });
  return created(res, withdrawal, 'Withdrawal requested.');
});

// GET /api/marketplace/sellers/mine/withdrawals
const mySellerWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await SellerWithdrawal.find({ seller: req.user._id }).sort({ createdAt: -1 });
  return ok(res, withdrawals);
});

// PATCH /api/marketplace/sellers/withdrawals/:id/status — Super Admin processes it (no back-office
// UI for this yet, same as the Agent's equivalent endpoint — usable for testing/ops today).
const updateSellerWithdrawalStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['requested', 'processing', 'paid', 'rejected'].includes(status)) throw new AppError('Invalid status.', 422);

  const withdrawal = await SellerWithdrawal.findById(req.params.id);
  if (!withdrawal) throw new AppError('Withdrawal not found.', 404);

  withdrawal.status = status;
  if (status === 'paid') withdrawal.processedAt = new Date();
  await withdrawal.save();

  const TITLE = {
    requested: `Withdrawal requested: ${withdrawal.currency} ${withdrawal.amount}`,
    processing: `Withdrawal processing: ${withdrawal.currency} ${withdrawal.amount}`,
    paid: `Payment received: ${withdrawal.currency} ${withdrawal.amount}`,
    rejected: `Withdrawal rejected: ${withdrawal.currency} ${withdrawal.amount}`
  };
  await notify(withdrawal.seller, { title: TITLE[status], sentBy: req.user._id }).catch(() => {});

  return ok(res, withdrawal, 'Withdrawal updated.');
});

// PATCH /api/marketplace/products/:id — a seller can freely move their own listing to
// draft/pending_approval/paused, and can un-pause back to active (it was already approved once).
// They can NOT self-approve from pending_approval/rejected, and can't set 'rejected' — those are
// Super Admin-only (see moderateProduct). Restocking an out-of-stock listing revives it to active.
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Listing not found.', 404);
  assertOwnsProduct(product, req.user._id);

  if (req.body.status !== undefined) {
    const requested = req.body.status;
    if (requested === 'rejected') throw new AppError('Only Super Admin can reject a listing.', 403);
    if (requested === 'active' && !['paused', 'out_of_stock'].includes(product.status)) {
      throw new AppError('This listing needs Super Admin approval before it can go active.', 403);
    }
    if (requested === 'out_of_stock') throw new AppError('Out of Stock is set automatically based on your stock count.', 422);
  }

  const allowed = ['title', 'description', 'category', 'price', 'currency', 'stock', 'images', 'status'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) product[f] = req.body[f]; });

  // Keep stock and status honest with each other — physical listings only, digital ones don't track stock.
  if (isPhysical(product)) {
    if (product.stock <= 0 && product.status === 'active') product.status = 'out_of_stock';
    else if (product.stock > 0 && product.status === 'out_of_stock') product.status = 'active';
  }

  await product.save();
  return ok(res, product);
});

// GET /api/marketplace/products/admin/pending — Super Admin's review queue.
const pendingProducts = asyncHandler(async (req, res) => {
  const products = await Product.find({ status: 'pending_approval' }).populate('seller', 'fullName email').sort({ createdAt: 1 });
  return ok(res, products);
});

// PATCH /api/marketplace/products/:id/moderate — Super Admin approves/rejects a pending listing.
const moderateProduct = asyncHandler(async (req, res) => {
  const { status, reviewNotes } = req.body;
  if (!['active', 'rejected'].includes(status)) throw new AppError('status must be "active" or "rejected".', 422);

  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Listing not found.', 404);

  product.status = status;
  product.reviewNotes = reviewNotes || '';
  await product.save();

  await notify(product.seller, {
    title: `Listing ${status}: ${product.title}`,
    body: status === 'rejected' ? reviewNotes || '' : '',
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, product, `Listing ${status}.`);
});

// DELETE /api/marketplace/products/:id
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Listing not found.', 404);
  assertOwnsProduct(product, req.user._id);
  await product.deleteOne();
  return ok(res, null, 'Listing removed.');
});

// POST /api/marketplace/products/:id/orders
const placeOrder = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Listing not found.', 404);
  if (product.status !== 'active') throw new AppError('This listing is not available.', 400);

  const quantity = Number(req.body.quantity) || 1;
  if (isPhysical(product) && product.stock < quantity) {
    throw new AppError('Not enough stock available.', 400);
  }

  const order = await Order.create({
    product: product._id,
    buyer: req.user._id,
    seller: product.seller,
    quantity,
    unitPrice: product.price,
    totalPrice: product.price * quantity,
    currency: product.currency,
    shippingAddress: req.body.shippingAddress || '',
    note: req.body.note || ''
  });

  // Digital listings (courses/services) don't track stock at all.
  if (isPhysical(product)) {
    product.stock = Math.max(0, product.stock - quantity);
    if (product.stock === 0) product.status = 'out_of_stock';
    await product.save();

    // Stock alert — item 8, deduped so repeat low-stock orders don't spam the same notification.
    if (product.stock === 0 || product.stock <= LOW_STOCK_THRESHOLD) {
      const title = product.stock === 0
        ? `Out of stock: ${product.title}`
        : `Low stock: ${product.title} (${product.stock} left)`;
      const already = await Notification.findOne({ user: product.seller, title });
      if (!already) await notify(product.seller, { title, sentBy: null }).catch(() => {});
    }
  }

  await notify(product.seller, {
    title: `New order: ${product.title} (${order.currency} ${order.totalPrice})`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, order, 'Order placed.');
});

// GET /api/marketplace/orders/mine (as buyer)
const myOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ buyer: req.user._id })
    .populate('product', 'title price currency images')
    .sort({ createdAt: -1 });
  return ok(res, orders);
});

// POST /api/marketplace/orders/:id/request-cancellation — buyer asks; the seller has to approve
// or deny it (Pending Actions item "Buyer cancellation requests"). Can't cancel something already
// finished.
const requestCancellation = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.buyer.toString() !== req.user._id.toString()) throw new AppError('You did not place this order.', 403);
  if (['delivered', 'completed', 'cancelled', 'refunded'].includes(order.status)) {
    throw new AppError('This order can no longer be cancelled.', 400);
  }

  order.cancellationRequested = true;
  order.cancellationReason = req.body.reason || '';
  await order.save();
  await notify(order.seller, { title: `Cancellation requested for order ${order._id.toString().slice(-8).toUpperCase()}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, order, 'Cancellation requested.');
});

// POST /api/marketplace/orders/:id/request-refund — only makes sense once the order was actually
// received (Pending Actions item "Refund/return requests").
const requestRefund = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.buyer.toString() !== req.user._id.toString()) throw new AppError('You did not place this order.', 403);
  if (!['delivered', 'completed'].includes(order.status)) {
    throw new AppError('You can only request a refund after the order has been delivered.', 400);
  }

  order.refundRequested = true;
  order.refundReason = req.body.reason || '';
  await order.save();
  await notify(order.seller, { title: `Refund/return requested for order ${order._id.toString().slice(-8).toUpperCase()}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, order, 'Refund/return requested.');
});

// PATCH /api/marketplace/orders/:id/cancellation-response — seller approves (order -> cancelled)
// or denies (flag clears, order continues) a buyer's cancellation request.
const respondToCancellation = asyncHandler(async (req, res) => {
  const { approve } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.seller.toString() !== req.user._id.toString()) throw new AppError('You are not the seller for this order.', 403);
  if (!order.cancellationRequested) throw new AppError('No cancellation request is pending on this order.', 400);

  order.cancellationRequested = false;
  if (approve) order.status = 'cancelled';
  await order.save();
  await notify(order.buyer, { title: `Cancellation ${approve ? 'approved' : 'declined'} for order ${order._id.toString().slice(-8).toUpperCase()}`, sentBy: req.user._id }).catch(() => {});
  if (approve) {
    await notify(order.seller, { title: `Order cancelled: ${order.currency} ${order.totalPrice}`, sentBy: req.user._id }).catch(() => {});
  }
  return ok(res, order, `Cancellation ${approve ? 'approved' : 'declined'}.`);
});

// PATCH /api/marketplace/orders/:id/refund-response — seller approves (order -> refunded,
// paymentStatus -> refunded) or denies (flag clears) a buyer's refund/return request.
const respondToRefund = asyncHandler(async (req, res) => {
  const { approve } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.seller.toString() !== req.user._id.toString()) throw new AppError('You are not the seller for this order.', 403);
  if (!order.refundRequested) throw new AppError('No refund/return request is pending on this order.', 400);

  order.refundRequested = false;
  if (approve) {
    order.status = 'refunded';
    order.paymentStatus = 'refunded';
  }
  await order.save();
  await notify(order.buyer, { title: `Refund/return ${approve ? 'approved' : 'declined'} for order ${order._id.toString().slice(-8).toUpperCase()}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, order, `Refund/return ${approve ? 'approved' : 'declined'}.`);
});

// GET /api/marketplace/orders/selling (as seller)
const sellerOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ seller: req.user._id })
    .populate('product', 'title price currency')
    .populate('buyer', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, orders);
});

const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];

// PATCH /api/marketplace/orders/:id/status
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.seller.toString() !== req.user._id.toString()) {
    throw new AppError('You are not the seller for this order.', 403);
  }

  order.status = status;
  // Refunding the order fulfillment implies the payment was refunded too — keep them in sync.
  if (status === 'refunded') order.paymentStatus = 'refunded';
  await order.save();

  if (status === 'cancelled') {
    await notify(req.user._id, { title: `Order cancelled: ${order.currency} ${order.totalPrice}`, sentBy: req.user._id }).catch(() => {});
  } else if (status === 'delivered' || status === 'completed') {
    await notify(req.user._id, { title: `Earnings available: ${order.currency} ${order.totalPrice} from order ${order._id.toString().slice(-8).toUpperCase()}`, sentBy: req.user._id }).catch(() => {});
  }

  return ok(res, order, `Order ${status}.`);
});

// PATCH /api/marketplace/orders/:id/payment-status — no real payment gateway, so the seller
// self-reports whether the money actually came in (same honesty pattern as Donation status).
const updatePaymentStatus = asyncHandler(async (req, res) => {
  const { paymentStatus } = req.body;
  if (!['pending', 'paid', 'failed', 'refunded'].includes(paymentStatus)) {
    throw new AppError('Invalid paymentStatus.', 422);
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.seller.toString() !== req.user._id.toString()) {
    throw new AppError('You are not the seller for this order.', 403);
  }

  order.paymentStatus = paymentStatus;
  await order.save();

  if (paymentStatus === 'paid') {
    await notify(req.user._id, { title: `Payment received: ${order.currency} ${order.totalPrice}`, sentBy: req.user._id }).catch(() => {});
  }

  return ok(res, order, `Payment marked ${paymentStatus}.`);
});

// POST /api/marketplace/orders/:id/review — a buyer reviews their own DELIVERED order. Verified
// purchase only (real, no fake reviews), and one review per order (schema-enforced unique index).
const submitReview = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) throw new AppError('rating must be between 1 and 5.', 422);

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.buyer.toString() !== req.user._id.toString()) throw new AppError('You did not place this order.', 403);
  if (order.status !== 'delivered') throw new AppError('You can only review an order after it has been delivered.', 400);

  const existing = await Review.findOne({ order: order._id });
  if (existing) throw new AppError('You already reviewed this order.', 409);

  const review = await Review.create({
    order: order._id,
    product: order.product,
    seller: order.seller,
    buyer: req.user._id,
    rating,
    comment: comment || ''
  });

  await notify(order.seller, { title: `New review: ★ ${rating}`, body: comment || '', sentBy: req.user._id }).catch(() => {});

  return created(res, review, 'Review submitted.');
});

// GET /api/marketplace/products/:id/reviews — public.
const productReviews = asyncHandler(async (req, res) => {
  const reviews = await Review.find({ product: req.params.id }).populate('buyer', 'fullName').sort({ createdAt: -1 });
  return ok(res, reviews);
});

// GET /api/marketplace/sellers/mine/reviews — Seller Dashboard item 11: every real review across
// every one of this seller's products (buyer reviews + recent feedback), so the seller can see
// and respond to all of it in one place, not per-product.
const mySellerReviews = asyncHandler(async (req, res) => {
  const reviews = await Review.find({ seller: req.user._id })
    .populate('buyer', 'fullName')
    .populate('product', 'title')
    .sort({ createdAt: -1 });
  return ok(res, reviews);
});

// PATCH /api/marketplace/reviews/:id/respond — a seller's public reply to a buyer's review.
const respondToReview = asyncHandler(async (req, res) => {
  const { response } = req.body;
  if (!response || !response.trim()) throw new AppError('response is required.', 422);

  const review = await Review.findById(req.params.id);
  if (!review) throw new AppError('Review not found.', 404);
  if (review.seller.toString() !== req.user._id.toString()) throw new AppError('You can only respond to reviews on your own listings.', 403);

  review.sellerResponse = response.trim();
  review.sellerRespondedAt = new Date();
  await review.save();

  await notify(review.buyer, { title: `The seller replied to your review`, sentBy: req.user._id }).catch(() => {});
  return ok(res, review, 'Response posted.');
});

// POST /api/marketplace/reviews/:id/report — a seller flags a review as inappropriate (fake,
// abusive, off-topic) for Super Admin to look at. Flags it; doesn't remove it — only an admin
// moderation action should do that, and there's no such panel yet, same honest limitation as the
// Product moderation queue had before it existed.
const reportReview = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const review = await Review.findById(req.params.id);
  if (!review) throw new AppError('Review not found.', 404);
  if (review.seller.toString() !== req.user._id.toString()) throw new AppError('You can only report reviews on your own listings.', 403);

  review.reported = true;
  review.reportReason = reason || '';
  await review.save();
  return ok(res, review, 'Review reported for Super Admin review.');
});

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  myProducts,
  mySellerProfile,
  mySellerSummary,
  mySalesOverview,
  myPendingActions,
  myReturnsRefunds,
  myBestSellingProducts,
  myInventory,
  getCommissionRate,
  setCommissionRate,
  myEarnings,
  myWallet,
  requestSellerWithdrawal,
  mySellerWithdrawals,
  updateSellerWithdrawalStatus,
  mySellerReviews,
  respondToReview,
  reportReview,
  updateProduct,
  pendingProducts,
  moderateProduct,
  deleteProduct,
  placeOrder,
  myOrders,
  sellerOrders,
  updateOrderStatus,
  updatePaymentStatus,
  requestCancellation,
  requestRefund,
  respondToCancellation,
  respondToRefund,
  submitReview,
  productReviews
};
