const router = require('express').Router();
const ctrl = require('../controllers/user.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.patch('/me', ctrl.updateMe);
router.patch('/me/password', ctrl.changePassword);

router.get('/', requireRole('admin', 'super_admin'), ctrl.listUsers);
router.get('/:id', requireRole('admin', 'super_admin'), ctrl.getUser);
router.patch('/:id/status', requireRole('admin', 'super_admin'), ctrl.setUserStatus);

module.exports = router;
