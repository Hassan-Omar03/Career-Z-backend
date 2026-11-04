const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');
const service = require('../services/receipt.service');

router.get('/verify/:number', asyncHandler(async (req, res) => ok(res, await service.verify(req.params.number))));
router.use(protect);
router.get('/mine', asyncHandler(async (req, res) => ok(res, await service.mine(req.user, req.query))));
const staff = [requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('finance')];
router.get('/admin/all', ...staff, asyncHandler(async (req, res) => ok(res, await service.adminList(req.query))));
router.get('/admin/charges', ...staff, asyncHandler(async (req, res) => ok(res, await service.chargesConfig())));
router.patch('/admin/charges', requireRole('super_admin'), asyncHandler(async (req, res) => ok(res, await service.setChargesConfig(req.body), 'Saved.')));
router.get('/:id', asyncHandler(async (req, res) => {
  const canSeeAll = (req.user.roles || []).some((r) => ['admin', 'super_admin'].includes(r));
  return ok(res, await service.readable(req.user, req.params.id, canSeeAll));
}));

module.exports = router;
