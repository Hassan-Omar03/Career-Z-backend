const router = require('express').Router();
const ctrl = require('../controllers/student.controller');
const certificateCtrl = require('../controllers/certificate.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

// Public — anyone scanning a Digital Student ID QR code can verify it, no login required.
router.get('/verify-id/:code', ctrl.verifyStudentId);

router.use(protect, requirePermission('student:profile:read:own'));

router.get('/me', ctrl.getMyProfile);
router.patch('/me', ctrl.updateMyProfile);
router.post('/me/connect-institution', ctrl.connectToInstitution);
router.post('/me/attendance/qr-checkin', ctrl.qrCheckIn);
router.post('/me/attendance/gps-checkin', ctrl.gpsCheckIn);
router.get('/me/attendance', ctrl.getMyAttendance);
router.get('/me/results', ctrl.getMyResults);
router.get('/me/enrollments', ctrl.getMyEnrollments);
router.get('/me/submissions', ctrl.getMySubmissions);
router.get('/me/fees', ctrl.getMyFees);
router.patch('/me/fees/:feeId/pay', ctrl.payMyFee);
router.get('/me/timetable', ctrl.getMyTimetable);
router.get('/me/certificates', certificateCtrl.getMyCertificates);
router.get('/me/dashboard', ctrl.getMyDashboard);
router.get('/me/documents', ctrl.listMyDocuments);
router.post('/me/documents', ctrl.addMyDocument);
router.patch('/me/documents/:id', ctrl.updateMyDocument);
router.delete('/me/documents/:id', ctrl.removeMyDocument);
router.get('/me/student-id', ctrl.getMyStudentId);
router.put('/me/face-descriptor', ctrl.saveMyFaceDescriptor);
router.get('/me/learning-analytics', ctrl.getMyLearningAnalytics);
router.get('/me/goals', ctrl.listMyGoals);
router.post('/me/goals', ctrl.addMyGoal);
router.patch('/me/goals/:id', ctrl.updateMyGoal);
router.delete('/me/goals/:id', ctrl.removeMyGoal);
router.get('/me/achievement-timeline', ctrl.getMyAchievementTimeline);
router.get('/me/badges', ctrl.getMyBadges);

module.exports = router;
