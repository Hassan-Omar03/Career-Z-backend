const router = require('express').Router();
const ctrl = require('../controllers/teacher.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);

// Payslips belong to any employed user (teachers, wardens, drivers, etc.).
// The controller always scopes both reads and verification to req.user._id.
router.get('/me/payslips', ctrl.getMyPayslips);
router.patch('/me/payslips/:id/verify-payment', ctrl.verifyMyPayslipPayment);

router.use(requirePermission('teacher:profile:read:own'));

router.get('/me', ctrl.getMyProfile);
router.patch('/me', ctrl.updateMyProfile);
router.get('/me/classes', ctrl.getMyClasses);
router.post('/me/attendance', ctrl.markAttendance);
router.post('/me/attendance/qr-session', ctrl.createQrSession);
router.get('/me/attendance/qr-session/:id', ctrl.getQrSession);
router.post('/me/attendance/face-scan', ctrl.markAttendanceByFace);
router.get('/me/attendance/face-requests', ctrl.listFaceCheckInRequests);
router.patch('/me/attendance/face-requests/:id', ctrl.reviewFaceCheckInRequest);
router.patch('/me/courses/:id/attendance-location', ctrl.setAttendanceLocation);
router.get('/me/attendance', ctrl.listAttendance);
router.post('/me/self-attendance/check-in', ctrl.checkInMyAttendance);
router.get('/me/self-attendance', ctrl.getMySelfAttendance);
router.get('/me/timetable', ctrl.getMyTimetable);
router.get('/me/dashboard', ctrl.getMyDashboard);
router.get('/students/:studentId/timeline', ctrl.getStudentTimeline);
router.get('/me/payout-status', ctrl.getMyPayoutStatus);
router.post('/me/payout-onboarding', ctrl.startPayoutOnboarding);
router.get('/me/engagement-history', ctrl.getMyEngagementHistory);

module.exports = router;
