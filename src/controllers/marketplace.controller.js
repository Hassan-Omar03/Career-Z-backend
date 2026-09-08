const Product = require('../models/Product');
const Order = require('../models/Order');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function assertOwnsProduct(product, userId) {
  if (product.seller.toString() !== userId.toString()) {
    throw new AppError('You do not own this listing.', 403);
  }
}

// POST /api/marketplace/products
const createProduct = asyncHandler(async (req, res) => {
  const allowed = ['title', 'description', 'category', 'price', 'currency', 'stock', 'images'];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || body.price === undefined) {
    throw new AppError('title and price are required.', 422);
  }

  const product = await Product.create({ ...body, seller: req.user._id });
  return created(res, product, 'Listing created.');
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

// GET /api/marketplace/products/:id
const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).populate('seller', 'fullName email');
  if (!product) throw new AppError('Listing not found.', 404);
  return ok(res, product);
});

// GET /api/marketplace/products/mine/list
const myProducts = asyncHandler(async (req, res) => {
  const products = await Product.find({ seller: req.user._id }).sort({ createdAt: -1 });
  return ok(res, products);
});

// PATCH /api/marketplace/products/:id
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Listing not found.', 404);
  assertOwnsProduct(product, req.user._id);

  const allowed = ['title', 'description', 'category', 'price', 'currency', 'stock', 'images', 'status'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) product[f] = req.body[f]; });
  await product.save();
  return ok(res, product);
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
  if (product.stock !== undefined && product.stock < quantity) {
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

  if (product.stock !== undefined) {
    product.stock = Math.max(0, product.stock - quantity);
    await product.save();
  }

  return created(res, order, 'Order placed.');
});

// GET /api/marketplace/orders/mine (as buyer)
const myOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ buyer: req.user._id })
    .populate('product', 'title price currency images')
    .sort({ createdAt: -1 });
  return ok(res, orders);
});

// GET /api/marketplace/orders/selling (as seller)
const sellerOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ seller: req.user._id })
    .populate('product', 'title price currency')
    .populate('buyer', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, orders);
});

// PATCH /api/marketplace/orders/:id/status
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found.', 404);
  if (order.seller.toString() !== req.user._id.toString()) {
    throw new AppError('You are not the seller for this order.', 403);
  }

  order.status = status;
  await order.save();
  return ok(res, order, `Order ${status}.`);
});

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  myProducts,
  updateProduct,
  deleteProduct,
  placeOrder,
  myOrders,
  sellerOrders,
  updateOrderStatus
};
