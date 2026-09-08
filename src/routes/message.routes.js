const router = require('express').Router();
const ctrl = require('../controllers/message.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.sendMessage);
router.get('/conversations', ctrl.listConversations);
router.get('/with/:userId', ctrl.getThread);
router.patch('/with/:userId/read', ctrl.markThreadRead);

module.exports = router;
