const router = require('express').Router();
const ctrl = require('../controllers/forum.controller');
const { protect } = require('../middleware/auth');

const postLimit = require('express-rate-limit')({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false });

router.use(protect);
router.get('/courses/:courseId/threads', ctrl.listThreads);
router.post('/courses/:courseId/threads', postLimit, ctrl.createThread);
router.get('/threads/:id', ctrl.getThread);
router.patch('/threads/:id', ctrl.updateThread);
router.post('/threads/:id/replies', postLimit, ctrl.createReply);
router.post('/threads/:id/accept', ctrl.acceptReply);
router.patch('/replies/:id', ctrl.updateReply);
router.post('/replies/:id/like', ctrl.toggleLike);

module.exports = router;
