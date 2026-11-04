const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');
const service = require('../services/commissionRules.service');

router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));
router.get('/', requireDepartment('finance'), asyncHandler(async (req, res) => ok(res, { rules: await service.list(), scopes: service.SCOPES, services: service.SERVICES })));
router.post('/', requireRole('super_admin'), asyncHandler(async (req, res) => created(res, await service.create(req.user, req.body), 'Rule created.')));
router.patch('/:id', requireRole('super_admin'), asyncHandler(async (req, res) => ok(res, await service.update(req.user, req.params.id, req.body), 'Rule updated.')));
router.post('/:id/status', requireRole('super_admin'), asyncHandler(async (req, res) => ok(res, await service.setStatus(req.user, req.params.id, req.body.status), 'Rule updated.')));

module.exports = router;
