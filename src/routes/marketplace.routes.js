const router = require('express').Router();
const ctrl = require('../controllers/marketplace.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required. Literal segments before "/products/:id" or Express
// matches them as an id (e.g. "/products/admin/pending" -> :id="admin").
router.get('/products', optionalAuth, ctrl.listProducts);
router.get('/products/admin/pending', protect, requireRole('admin', 'super_admin', 'platform_staff'), ctrl.pendingProducts);
router.get('/products/:id', optionalAuth, ctrl.getProduct);
router.get('/products/:id/reviews', optionalAuth, ctrl.productReviews);
router.get('/commission-rate', optionalAuth, ctrl.getCommissionRate);

router.use(protect);
router.patch('/products/:id/moderate', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.moderateProduct);
router.patch('/commission-rate', requireRole('super_admin'), ctrl.setCommissionRate);

// Seller — posting and managing listings.
router.post('/products', requireRole('marketplace_seller'), ctrl.createProduct);
router.get('/products/mine/list', requireRole('marketplace_seller'), ctrl.myProducts);
router.get('/sellers/mine/profile', requireRole('marketplace_seller'), ctrl.mySellerProfile);
router.get('/sellers/mine/summary', requireRole('marketplace_seller'), ctrl.mySellerSummary);
router.get('/sellers/mine/sales-overview', requireRole('marketplace_seller'), ctrl.mySalesOverview);
router.get('/sellers/mine/pending-actions', requireRole('marketplace_seller'), ctrl.myPendingActions);
router.get('/sellers/mine/returns-refunds', requireRole('marketplace_seller'), ctrl.myReturnsRefunds);
router.get('/sellers/mine/best-selling', requireRole('marketplace_seller'), ctrl.myBestSellingProducts);
router.get('/sellers/mine/inventory', requireRole('marketplace_seller'), ctrl.myInventory);
router.get('/sellers/mine/earnings', requireRole('marketplace_seller'), ctrl.myEarnings);
router.get('/sellers/mine/wallet', requireRole('marketplace_seller'), ctrl.myWallet);
router.post('/sellers/mine/withdraw', requireRole('marketplace_seller'), ctrl.requestSellerWithdrawal);
router.get('/sellers/mine/withdrawals', requireRole('marketplace_seller'), ctrl.mySellerWithdrawals);
router.get('/sellers/mine/reviews', requireRole('marketplace_seller'), ctrl.mySellerReviews);
router.patch('/reviews/:id/respond', requireRole('marketplace_seller'), ctrl.respondToReview);
router.post('/reviews/:id/report', requireRole('marketplace_seller'), ctrl.reportReview);
router.patch('/products/:id', requireRole('marketplace_seller'), ctrl.updateProduct);
router.delete('/products/:id', requireRole('marketplace_seller'), ctrl.deleteProduct);
router.get('/orders/selling', requireRole('marketplace_seller'), ctrl.sellerOrders);
router.patch('/orders/:id/status', requireRole('marketplace_seller'), ctrl.updateOrderStatus);
router.patch('/orders/:id/payment-status', requireRole('marketplace_seller'), ctrl.updatePaymentStatus);
router.patch('/orders/:id/cancellation-response', requireRole('marketplace_seller'), ctrl.respondToCancellation);
router.patch('/orders/:id/refund-response', requireRole('marketplace_seller'), ctrl.respondToRefund);

// Super Admin — processes a seller's withdrawal request (no back-office UI yet).
router.patch('/sellers/withdrawals/:id/status', requireRole('super_admin'), ctrl.updateSellerWithdrawalStatus);

// Any authenticated user — buying.
router.post('/products/:id/orders', ctrl.placeOrder);
router.get('/orders/mine', ctrl.myOrders);
router.post('/orders/:id/review', ctrl.submitReview);
router.post('/orders/:id/request-cancellation', ctrl.requestCancellation);
router.post('/orders/:id/request-refund', ctrl.requestRefund);

module.exports = router;
