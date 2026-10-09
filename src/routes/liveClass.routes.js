const router = require('express').Router();
const ctrl = require('../controllers/liveClass.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
const tools=require('../controllers/liveTools.controller');
router.get('/:id/rtc-config',tools.rtc);
router.get('/:id/tools',tools.state);
router.post('/:id/tools',tools.update);
router.post('/', ctrl.schedule);
router.get('/institution/:institutionId', ctrl.institutionList);
router.get('/teacher/mine', ctrl.teacherList);
router.get('/student/mine', ctrl.studentList);
router.patch('/:id/start', ctrl.start);
router.post('/:id/join', ctrl.join);
router.post('/:id/leave', ctrl.leave);
router.patch('/:id/end', ctrl.end);
router.get('/:id/roster',ctrl.roster);
router.patch('/:id/physical-attendance',ctrl.physicalAttendance);
router.post('/:id/recording',ctrl.recording);

module.exports = router;
