const router = require('express').Router();
const ctrl = require('../controllers/liveClass.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.post('/', ctrl.schedule);
router.get('/institution/:institutionId', ctrl.institutionList);
router.get('/teacher/mine', ctrl.teacherList);
router.get('/student/mine', ctrl.studentList);
router.patch('/:id/start', ctrl.start);
router.post('/:id/join', ctrl.join);
router.post('/:id/leave', ctrl.leave);
router.patch('/:id/end', ctrl.end);

module.exports = router;
