const router = require('express').Router();
const ctrl = require('../controllers/role.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.post('/request', ctrl.requestRole);
router.get('/my-requests', ctrl.myRequests);
router.post('/mine/:role/documents', ctrl.submitMyDocuments);

router.get('/pending', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.pendingRequests);
router.patch('/:id/review', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.reviewRequest);

module.exports = router;
