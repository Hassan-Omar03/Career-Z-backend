const router = require('express').Router();
const ctrl = require('../controllers/meeting.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createMeeting);
router.get('/mine', ctrl.myMeetings);
router.patch('/:id/status', ctrl.updateMeetingStatus);

module.exports = router;
