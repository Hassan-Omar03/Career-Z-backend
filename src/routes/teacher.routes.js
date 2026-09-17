const router = require('express').Router();
const ctrl = require('../controllers/teacher.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect, requirePermission('teacher:profile:read:own'));

router.get('/me', ctrl.getMyProfile);
router.patch('/me', ctrl.updateMyProfile);
router.get('/me/classes', ctrl.getMyClasses);
router.post('/me/attendance', ctrl.markAttendance);
router.post('/me/attendance/qr-scan', ctrl.markAttendanceByQr);
router.post('/me/attendance/face-scan', ctrl.markAttendanceByFace);
router.get('/me/attendance', ctrl.listAttendance);
router.post('/me/self-attendance/check-in', ctrl.checkInMyAttendance);
router.get('/me/self-attendance', ctrl.getMySelfAttendance);
router.get('/me/timetable', ctrl.getMyTimetable);
router.get('/me/payslips', ctrl.getMyPayslips);
router.get('/me/dashboard', ctrl.getMyDashboard);

module.exports = router;
