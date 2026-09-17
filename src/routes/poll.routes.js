const router = require('express').Router();
const ctrl = require('../controllers/poll.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.post('/', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.createPoll);
router.get('/mine', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.myPolls);
router.patch('/:id/close', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.closePoll);

router.get('/available', requireRole('student'), ctrl.availablePolls);
router.post('/:id/vote', requireRole('student'), ctrl.vote);

module.exports = router;
