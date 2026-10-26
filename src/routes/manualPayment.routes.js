const router = require('express').Router();
const ctrl = require('../controllers/manualPayment.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
// At most 20 receipt submissions per account per 15 minutes.
const limit = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user._id), skip: () => process.env.NODE_ENV === 'test', validate: false, message: { success: false, message: 'Too many payment submissions. Try again later.' } });

router.use(protect);
router.get('/mine', ctrl.mine);
router.get('/incoming', ctrl.incoming);
router.get('/admin', ctrl.adminList);
router.get('/platform-account', ctrl.account);
router.put('/platform-account', requireRole('super_admin'), ctrl.saveAccount);
router.patch('/:id/confirm', ctrl.confirm);
router.patch('/:id/decide', ctrl.decide);
router.get('/:id/proof/:leg', ctrl.proof);
router.get('/quote/:kind/:id?', ctrl.quote);
router.post('/:kind/:id?', limit, ctrl.submit);

module.exports = router;
