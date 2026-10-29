const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const svc = require('../services/plugins.service');

// Public: which optional modules are on (the menus hide the ones that are off).
router.get('/modules', wrap(async (req, res) => ok(res, Object.fromEntries((await svc.moduleList()).map((m) => [m.key, m.enabled])))));

router.use(protect, requireRole('admin', 'super_admin'));
router.get('/admin/modules', wrap(async (req, res) => ok(res, await svc.moduleList())));
router.patch('/admin/modules/:key', wrap(async (req, res) => ok(res, await svc.setModule(req.user, req.params.key, req.body?.enabled), 'Module saved.')));
router.get('/admin/events', wrap(async (req, res) => ok(res, svc.EVENTS)));
router.get('/admin', wrap(async (req, res) => ok(res, await svc.list())));
router.post('/admin', wrap(async (req, res) => created(res, await svc.create(req.user, req.body), 'Plugin added. Copy the secret now; it is shown once.')));
router.patch('/admin/:id', wrap(async (req, res) => ok(res, await svc.update(req.user, req.params.id, req.body), 'Plugin saved.')));
router.post('/admin/:id/test', wrap(async (req, res) => ok(res, await svc.test(req.user, req.params.id))));
router.delete('/admin/:id', wrap(async (req, res) => ok(res, await svc.remove(req.user, req.params.id), 'Plugin deleted.')));

module.exports = router;
