const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const svc = require('../services/adminModeration.service');

// Super Admin: remove fake / suspicious jobs, products and scholarships; full user details.
// Platform staff in the moderation department may work on listings; full user records stay with admins.
router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));
const adminsOnly = requireRole('admin', 'super_admin');
router.use(['/listings', '/:kind/:id/remove', '/:kind/:id/restore'], requireDepartment('moderation'));
router.get('/listings', wrap(async (req, res) => ok(res, await svc.search(req.query))));
router.post('/:kind/:id/remove', wrap(async (req, res) => ok(res, await svc.remove(req.user, req.params.kind, req.params.id, req.body || {}), 'Removed. The owner was told why.')));
router.post('/:kind/:id/restore', wrap(async (req, res) => ok(res, await svc.restore(req.user, req.params.kind, req.params.id), 'Restored.')));
router.get('/users', adminsOnly, wrap(async (req, res) => ok(res, await svc.users(req.query))));
router.get('/users/:id', adminsOnly, wrap(async (req, res) => ok(res, await svc.userDetail(req.params.id))));

module.exports = router;
