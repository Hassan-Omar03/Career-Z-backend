const router = require('express').Router();
const ctrl = require('../controllers/student.controller');
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

module.exports = router;
