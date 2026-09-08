const router = require('express').Router();
const ctrl = require('../controllers/security.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));

router.get('/login-attempts', ctrl.listLoginAttempts);
router.get('/blocked-ips', ctrl.listBlockedIps);
router.post('/blocked-ips', ctrl.blockIp);
router.delete('/blocked-ips/:id', ctrl.unblockIp);

module.exports = router;
