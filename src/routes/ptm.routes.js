const router = require('express').Router();
const ctrl = require('../controllers/ptm.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.requestMeeting);
router.get('/mine', ctrl.myMeetings);
router.patch('/:id/respond', ctrl.respondToMeeting);
router.patch('/:id/cancel', ctrl.cancelMeeting);
router.patch('/:id/complete', ctrl.completeMeeting);
router.patch('/:id/no-show', ctrl.markNoShow);
router.patch('/:id/minutes', ctrl.updateMinutes);
router.post('/:id/action-items', ctrl.addActionItem);
router.patch('/:id/action-items/:itemId', ctrl.toggleActionItem);

router.post('/recurring', ctrl.createRecurringSchedule);
router.get('/recurring/mine', ctrl.myRecurringSchedules);
router.patch('/recurring/:id', ctrl.setRecurringScheduleActive);
router.get('/recurring/for-child/:studentId', ctrl.childRecurringSchedules);
router.post('/recurring/:id/book', ctrl.bookRecurringOccurrence);

router.get('/escalations/:institutionId', ctrl.listEscalations);
router.patch('/escalations/:id/acknowledge', ctrl.acknowledgeEscalation);

module.exports = router;
