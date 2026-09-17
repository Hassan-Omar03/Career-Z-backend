const router = require('express').Router();
const ctrl = require('../controllers/ptm.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.requestMeeting);
router.get('/mine', ctrl.myMeetings);
router.patch('/:id/respond', ctrl.respondToMeeting);
router.patch('/:id/cancel', ctrl.cancelMeeting);

module.exports = router;
