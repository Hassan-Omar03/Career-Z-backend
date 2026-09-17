const router = require('express').Router();
const ctrl = require('../controllers/parent.controller');
const ptmCtrl = require('../controllers/ptm.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/link-requests', ctrl.requestLink);
router.get('/link-requests', ctrl.myLinkRequests);
router.get('/incoming-requests', ctrl.incomingRequests);
router.patch('/link-requests/:id/respond', ctrl.respondToLink);

router.get('/me/dashboard', ctrl.getMyDashboard);

router.get('/children', ctrl.myChildren);
router.get('/children/:studentId/attendance', ctrl.childAttendance);
router.get('/children/:studentId/results', ctrl.childResults);
router.get('/children/:studentId/fees', ctrl.childFees);
router.patch('/children/:studentId/fees/:feeId/pay', ctrl.payChildFee);
router.get('/children/:studentId/timetable', ctrl.childTimetable);
router.get('/children/:studentId/homework', ctrl.childHomework);
router.get('/children/:studentId/exams', ctrl.childExams);
router.get('/children/:studentId/certificates', ctrl.childCertificates);
router.get('/children/:studentId/health', ctrl.getChildHealth);
router.patch('/children/:studentId/health', ctrl.updateChildHealth);
router.get('/children/:studentId/permissions', ctrl.listChildPermissions);
router.post('/children/:studentId/permissions', ctrl.grantChildPermission);
router.get('/children/:studentId/teachers', ptmCtrl.listChildTeachers);

module.exports = router;
