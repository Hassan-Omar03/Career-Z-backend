const router = require('express').Router();
const ctrl = require('../controllers/teacherFeedback.controller');
const { protect } = require('../middleware/auth');

router.get('/:teacherId', ctrl.getTeacherReputation);

router.use(protect);
router.post('/:teacherId', ctrl.submitFeedback);

module.exports = router;
