const router = require('express').Router();
const ctrl = require('../controllers/studyGroup.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/', ctrl.listGroups);
router.get('/mine', ctrl.myGroups);
router.post('/', ctrl.createGroup);
router.get('/:id', ctrl.getGroup);
router.post('/:id/join', ctrl.joinGroup);
router.post('/:id/leave', ctrl.leaveGroup);
router.get('/:id/posts', ctrl.listPosts);
router.post('/:id/posts', ctrl.addPost);

module.exports = router;
