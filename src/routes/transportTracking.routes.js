const router = require('express').Router();
const ctrl = require('../controllers/transportTracking.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/vehicles/:vehicleId/journeys/start', ctrl.startJourney);
router.patch('/journeys/:id/end', ctrl.endJourney);
router.post('/journeys/:id/ping', ctrl.postPing);
router.post('/journeys/:id/sos', ctrl.triggerSos);
router.post('/journeys/:id/board', ctrl.staffConfirmBoarding);
router.get('/journeys/:id/qr', ctrl.getBoardingQr);
router.post('/journeys/board-by-qr', ctrl.studentSelfBoard);
router.get('/journeys/:id', ctrl.getJourneyStatus);
router.get('/my-children', ctrl.myChildrenTransport);

module.exports = router;
