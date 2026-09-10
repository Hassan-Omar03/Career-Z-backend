const router = require('express').Router();
const ctrl = require('../controllers/notification.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.get('/mine', ctrl.listMine);
router.patch('/mine/read-all', ctrl.markAllRead);
router.patch('/:id/read', ctrl.markRead);
router.post('/platform-announcement', requireRole('super_admin'), ctrl.platformAnnouncement);

module.exports = router;
