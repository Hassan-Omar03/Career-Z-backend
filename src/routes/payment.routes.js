const router = require('express').Router();
const ctrl = require('../controllers/payment.controller');
const jazzcash = require('../controllers/jazzcash.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.get('/stripe/config', ctrl.getStripeConfig);
router.get('/paddle/config', ctrl.getPaddleConfig);
router.get('/nowpayments/config', ctrl.getNowPaymentsConfig);
router.get('/jazzcash/config', jazzcash.getConfig);
// JazzCash posts the payer's browser back here (no auth header) — verified by its secure hash.
router.post('/jazzcash/return', jazzcash.handleReturn);
router.post('/jazzcash/ipn', jazzcash.handleIpn);

router.use(protect);
router.post('/pending/sync', require('express-rate-limit')({ windowMs: 60000, max: 4, standardHeaders: true, legacyHeaders: false }), require('../controllers/paymentRecovery.controller').syncPendingPayments);
router.post('/stripe/fees/:feeId/checkout', ctrl.createFeeCheckoutSession);
router.post('/stripe/courses/:courseId/checkout', requirePermission('course:enroll:own'), ctrl.createStripeCourseCheckout);
router.post('/paddle/fees/:feeId/checkout', ctrl.createPaddleTransaction);
router.post('/paddle/courses/:courseId/checkout', requirePermission('course:enroll:own'), ctrl.createPaddleCourseCheckout);
router.get('/paddle/fees/:feeId/sync', ctrl.syncPaddleFeeStatus);
router.get('/paddle/courses/:courseId/transactions/:transactionId/sync', requirePermission('course:enroll:own'), ctrl.syncPaddleCourseStatus);
router.post('/paddle/wallet/topup', ctrl.createWalletTopup);
router.get('/paddle/wallet/topup/:transactionId/sync', ctrl.syncWalletTopup);
router.post('/nowpayments/wallet/topup', ctrl.createCryptoWalletTopup);
router.post('/jazzcash/fees/:feeId/checkout', jazzcash.createFeeCheckout);
router.post('/jazzcash/courses/:courseId/checkout', requirePermission('course:enroll:own'), jazzcash.createCourseCheckout);
router.post('/jazzcash/wallet/topup', jazzcash.createWalletTopup);
router.get('/jazzcash/:txnRefNo/sync', jazzcash.syncPayment);
router.get('/nowpayments/wallet/topup/:paymentId/sync', ctrl.syncCryptoWalletTopup);
router.post('/paddle/jobs/:jobId/feature-checkout', requirePermission('job:create:own'), ctrl.createPaddleFeaturedJobCheckout);
router.get('/paddle/jobs/:jobId/feature-checkout/:transactionId/sync', requirePermission('job:create:own'), ctrl.syncPaddleFeaturedJobStatus);

module.exports = router;
