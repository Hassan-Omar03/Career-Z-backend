const router = require('express').Router();
const ctrl = require('../controllers/teacher.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect, requirePermission('teacher:profile:read:own'));

router.get('/me', ctrl.getMyProfile);
router.patch('/me', ctrl.updateMyProfile);
router.get('/me/classes', ctrl.getMyClasses);
router.post('/me/attendance', ctrl.markAttendance);
router.get('/me/attendance', ctrl.listAttendance);

module.exports = router;
