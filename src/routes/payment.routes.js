const router = require('express').Router();
const ctrl = require('../controllers/payment.controller');
const jazzcash = require('../controllers/jazzcash.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

// JazzCash handles every checkout; NOWPayments (crypto) is an extra wallet top-up option.
router.get('/nowpayments/config', ctrl.getNowPaymentsConfig);
router.get('/jazzcash/config', jazzcash.getConfig);
// JazzCash posts the payer's browser back here (no auth header) — verified by its secure hash.
router.post('/jazzcash/return', jazzcash.handleReturn);
const safepayCtrl = require('../controllers/safepay.controller');
router.get('/safepay/config', safepayCtrl.getConfig);
router.get('/safepay/return', safepayCtrl.handleReturn);
router.post('/safepay/return', safepayCtrl.handleReturn);
router.get('/safepay/cancel', safepayCtrl.handleCancel);
router.post('/jazzcash/ipn', jazzcash.handleIpn);

router.use(protect);
router.post('/pending/sync', require('express-rate-limit')({ windowMs: 60000, max: 4, standardHeaders: true, legacyHeaders: false }), require('../controllers/paymentRecovery.controller').syncPendingPayments);
router.post('/nowpayments/wallet/topup', ctrl.createCryptoWalletTopup);
router.get('/nowpayments/wallet/topup/:paymentId/sync', ctrl.syncCryptoWalletTopup);
router.post('/jazzcash/fees/:feeId/checkout', jazzcash.createFeeCheckout);
router.post('/jazzcash/courses/:courseId/checkout', requirePermission('course:enroll:own'), jazzcash.createCourseCheckout);
router.post('/jazzcash/wallet/topup', jazzcash.createWalletTopup);
router.post('/jazzcash/jobs/:jobId/feature-checkout', requirePermission('job:create:own'), jazzcash.createFeaturedJobCheckout);
router.get('/jazzcash/:txnRefNo/sync', jazzcash.syncPayment);
router.get('/safepay/:txnRefNo/sync', safepayCtrl.syncPayment);

module.exports = router;
