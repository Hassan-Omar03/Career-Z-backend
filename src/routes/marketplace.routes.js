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
const wrapE = require('../utils/asyncHandler');
const esc = () => require('../services/marketplaceEscrow.service');
const sendPdf = (res, f, inline) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`); res.setHeader('Cache-Control', 'private, no-store'); return res.send(f.data); };
// Digital product preview (first pages, stamped PREVIEW) and the seller's public trust score.
router.get('/products/:id/preview', optionalAuth, wrapE(async (req, res) => sendPdf(res, await esc().previewFile(req.params.id, req.user), true)));
router.get('/sellers/:id/trust', wrapE(async (req, res) => res.json({ success: true, data: await esc().sellerTrust(req.params.id) })));

// Quick checkout for visitors without an account (email code), rate limited.
const quickLimit = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const wrapQ = require('../utils/asyncHandler');
router.post('/quick-checkout/start', quickLimit, wrapQ(async (req, res) => res.json({ success: true, message: 'We emailed you a 6-digit code.', data: await require('../services/quickBuyer.service').start(req.body || {}) })));
router.post('/quick-checkout/verify', quickLimit, wrapQ(async (req, res) => res.json({ success: true, message: 'Email confirmed.', data: await require('../services/quickBuyer.service').verify(req.body || {}, { ip: req.ip, deviceInfo: req.headers['user-agent'] }) })));

router.use(protect);
router.patch('/products/:id/moderate', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.moderateProduct);
router.patch('/commission-rate', requireRole('super_admin'), ctrl.setCommissionRate);

// Seller — posting and managing listings. A verified student may sell too (master: in the
// student marketplace a student is both buyer and seller).
router.post('/products', requireRole('marketplace_seller', 'student'), ctrl.createProduct);
router.get('/products/mine/list', requireRole('marketplace_seller', 'student'), ctrl.myProducts);
router.get('/sellers/mine/profile', requireRole('marketplace_seller', 'student'), ctrl.mySellerProfile);
router.get('/sellers/mine/summary', requireRole('marketplace_seller', 'student'), ctrl.mySellerSummary);
router.get('/sellers/mine/sales-overview', requireRole('marketplace_seller', 'student'), ctrl.mySalesOverview);
router.get('/sellers/mine/pending-actions', requireRole('marketplace_seller', 'student'), ctrl.myPendingActions);
router.get('/sellers/mine/returns-refunds', requireRole('marketplace_seller', 'student'), ctrl.myReturnsRefunds);
router.get('/sellers/mine/best-selling', requireRole('marketplace_seller', 'student'), ctrl.myBestSellingProducts);
router.get('/sellers/mine/inventory', requireRole('marketplace_seller', 'student'), ctrl.myInventory);
router.get('/sellers/mine/earnings', requireRole('marketplace_seller', 'student'), ctrl.myEarnings);
router.get('/sellers/mine/wallet', requireRole('marketplace_seller', 'student'), ctrl.myWallet);
router.post('/sellers/mine/withdraw', requireRole('marketplace_seller', 'student'), ctrl.requestSellerWithdrawal);
router.get('/sellers/mine/withdrawals', requireRole('marketplace_seller', 'student'), ctrl.mySellerWithdrawals);
router.get('/sellers/mine/reviews', requireRole('marketplace_seller', 'student'), ctrl.mySellerReviews);
router.patch('/reviews/:id/respond', requireRole('marketplace_seller', 'student'), ctrl.respondToReview);
router.post('/reviews/:id/report', requireRole('marketplace_seller', 'student'), ctrl.reportReview);
router.patch('/products/:id', requireRole('marketplace_seller', 'student'), ctrl.updateProduct);
router.delete('/products/:id', requireRole('marketplace_seller', 'student'), ctrl.deleteProduct);
router.get('/orders/selling', requireRole('marketplace_seller', 'student'), ctrl.sellerOrders);
router.patch('/orders/:id/status', requireRole('marketplace_seller', 'student'), ctrl.updateOrderStatus);
router.patch('/orders/:id/payment-status', requireRole('marketplace_seller', 'student'), ctrl.updatePaymentStatus);
router.patch('/orders/:id/cancellation-response', requireRole('marketplace_seller', 'student'), ctrl.respondToCancellation);
router.patch('/orders/:id/refund-response', requireRole('marketplace_seller', 'student'), ctrl.respondToRefund);

// Super Admin — processes a seller's withdrawal request (no back-office UI yet).
// CareerZ finance (checked in the controller) lists and processes seller payouts.
router.get('/sellers/withdrawals/open', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.openSellerWithdrawals);
router.patch('/sellers/withdrawals/:id/status', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.updateSellerWithdrawalStatus);

// Any authenticated user — buying.
router.post('/products/:id/orders', ctrl.placeOrder);
router.get('/orders/mine', ctrl.myOrders);
router.get('/me/shipping', ctrl.myShipping);
const buyer = () => require('../services/marketplaceBuyer.service');
router.patch('/orders/:id/quantity', wrapE(async (req, res) => res.json({ success: true, message: 'Quantity updated.', data: await buyer().changeQuantity(req.user, req.params.id, req.body?.quantity) })));
router.patch('/orders/:id/shipping', wrapE(async (req, res) => res.json({ success: true, message: 'Delivery details updated.', data: await buyer().changeShipping(req.user, req.params.id, req.body || {}) })));
router.get('/orders/:id/messages', wrapE(async (req, res) => res.json({ success: true, data: await buyer().messages(req.user, req.params.id) })));
router.post('/orders/:id/messages', wrapE(async (req, res) => res.json({ success: true, message: 'Sent.', data: await buyer().postMessage(req.user, req.params.id, req.body?.text) })));
router.post('/orders/:id/cancel', wrapE(async (req, res) => res.json({ success: true, message: 'Order cancelled.', data: await buyer().cancel(req.user, req.params.id, req.body?.reason) })));
router.get('/sellers/mine/report', requireRole('marketplace_seller', 'student'), wrapE(async (req, res) => res.json({ success: true, data: await buyer().sellerReport(req.user) })));
router.post('/orders/:id/review', ctrl.submitReview);
router.post('/orders/:id/request-cancellation', ctrl.requestCancellation);
router.post('/orders/:id/request-refund', ctrl.requestRefund);
// Escrow: release, delivery code, disputes, digital file.
router.post('/orders/:id/confirm-received', wrapE(async (req, res) => res.json({ success: true, message: 'Thank you. The payment was released to the seller.', data: await esc().confirmReceived(req.user, req.params.id) })));
router.post('/orders/:id/deliver', requireRole('marketplace_seller', 'student'), wrapE(async (req, res) => res.json({ success: true, message: 'Delivered. The payment was released to your wallet.', data: await esc().deliverWithCode(req.user, req.params.id, req.body?.code) })));
router.post('/orders/:id/dispute', wrapE(async (req, res) => res.json({ success: true, message: 'Dispute opened. CareerZ holds the payment until it decides.', data: await esc().openDispute(req.user, req.params.id, req.body || {}) })));
router.post('/orders/:id/dispute/evidence', wrapE(async (req, res) => res.json({ success: true, message: 'Evidence added.', data: await esc().addEvidence(req.user, req.params.id, req.body || {}) })));
router.get('/orders/:id/dispute/evidence/:i', wrapE(async (req, res) => { const isAdmin = (req.user.roles || []).some((r) => ['admin', 'super_admin', 'platform_staff'].includes(r)); return require('../controllers/resume.controller').sendPrivateFile(res, await esc().evidenceFile(req.user, req.params.id, req.params.i, isAdmin)); }));
router.get('/orders/:id/file', wrapE(async (req, res) => { const f = await esc().purchasedFile(req.user, req.params.id, req.query.mode, { ip: req.ip }); return sendPdf(res, f, f.inline); }));
router.get('/admin/escrow', requireRole('admin', 'super_admin', 'platform_staff'), wrapE(async (req, res) => res.json({ success: true, data: await esc().adminEscrow() })));
router.patch('/admin/orders/:id/dispute', requireRole('admin', 'super_admin'), wrapE(async (req, res) => res.json({ success: true, message: 'Dispute decided.', data: await esc().decideDispute(req.user, req.params.id, req.body || {}) })));
router.patch('/admin/orders/:id/refunded', requireRole('admin', 'super_admin'), wrapE(async (req, res) => res.json({ success: true, message: 'Refund recorded.', data: await esc().markRefunded(req.user, req.params.id, req.body || {}) })));

module.exports = router;
