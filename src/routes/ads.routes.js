const router = require('express').Router();
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const ads = require('../services/ads.service');

// Public: one ad for a placement, and the click-through.
router.get('/slot', optionalAuth, wrap(async (req, res) => ok(res, await ads.slot(String(req.query.placement || ''), req.user))));
router.get('/:id/go', wrap(async (req, res) => { const link = await ads.click(req.params.id); return link ? res.redirect(302, link) : res.status(404).json({ success: false, message: 'Ad not found.' }); }));
router.get('/ad-free/price', wrap(async (req, res) => ok(res, (await ads.config()).adFree)));

router.use(protect);
router.get('/ad-free/mine', wrap(async (req, res) => ok(res, await ads.myAdFree(req.user))));
const admin = requireRole('admin', 'super_admin');
router.get('/admin/config', admin, wrap(async (req, res) => ok(res, await ads.config())));
router.put('/admin/config', admin, wrap(async (req, res) => ok(res, await ads.setConfig(req.user, req.body || {}), 'Ad settings saved.')));
router.get('/admin', admin, wrap(async (req, res) => ok(res, await ads.list())));
router.get('/admin/ad-free', admin, wrap(async (req, res) => ok(res, await ads.adFreeInstitutions())));
router.get('/admin/:id', admin, wrap(async (req, res) => ok(res, await ads.get(req.params.id))));
router.post('/admin', admin, wrap(async (req, res) => created(res, await ads.create(req.user, req.body), 'Ad created.')));
router.patch('/admin/:id', admin, wrap(async (req, res) => ok(res, await ads.update(req.user, req.params.id, req.body), 'Ad saved.')));
router.delete('/admin/:id', admin, wrap(async (req, res) => ok(res, await ads.remove(req.user, req.params.id), 'Ad deleted.')));

module.exports = router;
