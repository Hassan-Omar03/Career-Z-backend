const router = require('express').Router();
const ctrl = require('../controllers/parent.controller');
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
router.get('/children/:studentId/timetable', ctrl.childTimetable);
router.get('/children/:studentId/homework', ctrl.childHomework);
router.get('/children/:studentId/exams', ctrl.childExams);
router.get('/children/:studentId/certificates', ctrl.childCertificates);

module.exports = router;
