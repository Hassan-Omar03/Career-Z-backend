const router = require('express').Router();
const ctrl = require('../controllers/commission.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.get('/rate', ctrl.getCommissionRate);
router.patch('/rate', requireRole('super_admin'), ctrl.setCommissionRate);
router.get('/mine', ctrl.myCommissions);
router.get('/mine/withdrawals', ctrl.myWithdrawals);
router.post('/withdraw', ctrl.requestWithdrawal);
router.patch('/:id/status', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.updateCommissionStatus);
router.patch('/withdrawals/:id/status', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.updateWithdrawalStatus);

module.exports = router;
