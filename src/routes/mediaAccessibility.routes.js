const router = require('express').Router();
const ctrl = require('../controllers/mediaAccessibility.controller');
const { protect } = require('../middleware/auth');

const heavy = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// Public: <video><track src> cannot send auth headers; the 32-hex token is the capability.
router.get('/tracks/:file', ctrl.serveTrack);

router.use(protect);
router.get('/lessons/:lessonId/tracks', ctrl.listTracks);
router.post('/lessons/:lessonId/transcribe', heavy, ctrl.transcribeLesson);
router.post('/tracks/:trackId/translate', heavy, ctrl.translateTrack);
router.delete('/tracks/:trackId', ctrl.deleteTrack);

module.exports = router;
