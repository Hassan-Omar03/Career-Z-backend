const router = require('express').Router();
const ctrl = require('../controllers/notification.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

const settings = require('../controllers/notificationSettings.controller');
// One-click unsubscribe from an alert email: no login, the token identifies the person.
router.get('/unsubscribe', settings.unsubscribe);

router.use(protect);

router.get('/settings', settings.getSettings);
router.put('/settings', settings.saveSettings);

router.get('/push/public-key', ctrl.getPushPublicKey);
router.post('/push/subscriptions', ctrl.savePushSubscription);
router.delete('/push/subscriptions', ctrl.deletePushSubscription);
router.get('/mine', ctrl.listMine);
router.get('/mine/unread-count', ctrl.getUnreadCount);
router.patch('/mine/read-all', ctrl.markAllRead);
router.patch('/:id/read', ctrl.markRead);
router.post('/platform-announcement', requireRole('super_admin'), ctrl.platformAnnouncement);

module.exports = router;
