const router = require('express').Router();
const ctrl = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.get('/stripe/config', ctrl.getStripeConfig);
router.get('/paddle/config', ctrl.getPaddleConfig);
router.get('/nowpayments/config', ctrl.getNowPaymentsConfig);

router.use(protect);
router.post('/stripe/fees/:feeId/checkout', ctrl.createFeeCheckoutSession);
router.post('/stripe/courses/:courseId/checkout', requirePermission('course:enroll:own'), ctrl.createStripeCourseCheckout);
router.post('/paddle/fees/:feeId/checkout', ctrl.createPaddleTransaction);
router.post('/paddle/courses/:courseId/checkout', requirePermission('course:enroll:own'), ctrl.createPaddleCourseCheckout);
router.get('/paddle/fees/:feeId/sync', ctrl.syncPaddleFeeStatus);
router.get('/paddle/courses/:courseId/transactions/:transactionId/sync', requirePermission('course:enroll:own'), ctrl.syncPaddleCourseStatus);
router.post('/paddle/wallet/topup', ctrl.createWalletTopup);
router.get('/paddle/wallet/topup/:transactionId/sync', ctrl.syncWalletTopup);
router.post('/nowpayments/wallet/topup', ctrl.createCryptoWalletTopup);
router.get('/nowpayments/wallet/topup/:paymentId/sync', ctrl.syncCryptoWalletTopup);
router.post('/paddle/jobs/:jobId/feature-checkout', requirePermission('job:create:own'), ctrl.createPaddleFeaturedJobCheckout);
router.get('/paddle/jobs/:jobId/feature-checkout/:transactionId/sync', requirePermission('job:create:own'), ctrl.syncPaddleFeaturedJobStatus);

module.exports = router;
