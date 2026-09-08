const router = require('express').Router();
const ctrl = require('../controllers/student.controller');
const certificateCtrl = require('../controllers/certificate.controller');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect, requirePermission('student:profile:read:own'));

router.get('/me', ctrl.getMyProfile);
router.patch('/me', ctrl.updateMyProfile);
router.post('/me/connect-institution', ctrl.connectToInstitution);
router.get('/me/attendance', ctrl.getMyAttendance);
router.get('/me/results', ctrl.getMyResults);
router.get('/me/enrollments', ctrl.getMyEnrollments);
router.get('/me/submissions', ctrl.getMySubmissions);
router.get('/me/fees', ctrl.getMyFees);
router.get('/me/timetable', ctrl.getMyTimetable);
router.get('/me/certificates', certificateCtrl.getMyCertificates);

module.exports = router;
