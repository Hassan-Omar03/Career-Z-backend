const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const svc = require('../services/commentsRatings.service');

// Super Admin Comments & Ratings desk.
router.use(protect, requireRole('admin', 'super_admin'));
router.get('/', wrap(async (req, res) => ok(res, await svc.list(req.query))));
router.get('/report', wrap(async (req, res) => ok(res, await svc.report(req.query))));
router.patch('/:source/:id', wrap(async (req, res) => ok(res, await svc.moderate(req.user, req.params.source, req.params.id, req.body || {}), 'Saved.')));

module.exports = router;
