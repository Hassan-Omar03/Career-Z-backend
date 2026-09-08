const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));

router.get('/finance', ctrl.getFinanceSummary);
router.get('/reports', ctrl.getPlatformReports);

module.exports = router;
