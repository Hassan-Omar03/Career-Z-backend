const router = require('express').Router();
const ctrl = require('../controllers/groupConversation.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createGroup);
router.get('/mine', ctrl.myGroups);
router.get('/:id/messages', ctrl.listMessages);
router.post('/:id/messages', ctrl.sendMessage);
router.patch('/:id/leave', ctrl.leaveGroup);

module.exports = router;
