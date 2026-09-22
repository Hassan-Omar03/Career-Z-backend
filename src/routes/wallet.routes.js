const router = require('express').Router();
const ctrl = require('../controllers/wallet.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.get('/me', ctrl.getMyWallet);
router.post('/withdraw', ctrl.requestWithdrawal);
router.post('/transfer', ctrl.transfer);

router.get('/withdrawals/pending', requireRole('admin', 'super_admin'), ctrl.listPendingWithdrawals);
router.patch('/withdrawals/:id/review', requireRole('admin', 'super_admin'), ctrl.reviewWithdrawal);

module.exports = router;
