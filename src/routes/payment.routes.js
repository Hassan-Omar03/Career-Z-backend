const router = require('express').Router();
const ctrl = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth');

router.get('/stripe/config', ctrl.getStripeConfig);
router.get('/paddle/config', ctrl.getPaddleConfig);

router.use(protect);
router.post('/stripe/fees/:feeId/checkout', ctrl.createFeeCheckoutSession);
router.post('/paddle/fees/:feeId/checkout', ctrl.createPaddleTransaction);
router.get('/paddle/fees/:feeId/sync', ctrl.syncPaddleFeeStatus);

module.exports = router;
