const router = require('express').Router();
const ctrl = require('../controllers/marketplace.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required.
router.get('/products', optionalAuth, ctrl.listProducts);
router.get('/products/:id', optionalAuth, ctrl.getProduct);

router.use(protect);

// Seller — posting and managing listings.
router.post('/products', requireRole('marketplace_seller'), ctrl.createProduct);
router.get('/products/mine/list', requireRole('marketplace_seller'), ctrl.myProducts);
router.patch('/products/:id', requireRole('marketplace_seller'), ctrl.updateProduct);
router.delete('/products/:id', requireRole('marketplace_seller'), ctrl.deleteProduct);
router.get('/orders/selling', requireRole('marketplace_seller'), ctrl.sellerOrders);
router.patch('/orders/:id/status', requireRole('marketplace_seller'), ctrl.updateOrderStatus);

// Any authenticated user — buying.
router.post('/products/:id/orders', ctrl.placeOrder);
router.get('/orders/mine', ctrl.myOrders);

module.exports = router;
