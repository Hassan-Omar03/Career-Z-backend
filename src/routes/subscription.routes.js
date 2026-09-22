const router = require('express').Router();
const ctrl = require('../controllers/subscription.controller');
const { protect } = require('../middleware/auth');

router.get('/plans', ctrl.getPlans);

router.use(protect);
router.get('/institutions/:id', ctrl.getInstitutionSubscription);
router.post('/institutions/:id/checkout', ctrl.createSubscriptionCheckout);
router.get('/institutions/:id/checkout/:transactionId/sync', ctrl.syncSubscriptionCheckout);

module.exports = router;
