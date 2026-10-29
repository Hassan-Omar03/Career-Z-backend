const router = require('express').Router();
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const v = require('../services/visa.service');

// Public: country rules and verified visa consultants.
router.get('/countries', optionalAuth, wrap(async (req, res) => ok(res, await v.listRules())));
router.get('/countries/:code', optionalAuth, wrap(async (req, res) => ok(res, await v.getRule(req.params.code))));
router.get('/consultants', optionalAuth, wrap(async (req, res) => ok(res, await v.consultants(req.query.country))));

router.use(protect);
router.post('/ask', require('express-rate-limit')({ windowMs: 60000, max: 8, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => ok(res, await v.ask(req.user, req.body || {}))));
router.get('/cases/mine', wrap(async (req, res) => ok(res, await v.myCases(req.user))));
router.get('/cases/:id', wrap(async (req, res) => { const { c, side } = await v.caseFor(req.user, req.params.id); return ok(res, { ...c.toObject(), side }); }));
router.post('/applications/:appId/case', wrap(async (req, res) => created(res, await v.openCase(req.user, req.params.appId, req.body || {}), 'Visa case opened. The candidate has been told.')));
router.patch('/cases/:id/stage', wrap(async (req, res) => ok(res, await v.setStage(req.user, req.params.id, req.body || {}), 'Step updated.')));
router.patch('/cases/:id/outcome', wrap(async (req, res) => ok(res, await v.setOutcome(req.user, req.params.id, req.body || {}), 'Case updated.')));
router.patch('/cases/:id/consultant', wrap(async (req, res) => ok(res, await v.assignConsultant(req.user, req.params.id, req.body?.consultant), 'Consultant updated.')));
router.post('/cases/:id/documents', wrap(async (req, res) => ok(res, await v.addDocument(req.user, req.params.id, req.body || {}), 'Document added.')));
router.get('/cases/:id/documents/:i', wrap(async (req, res) => require('../controllers/resume.controller').sendPrivateFile(res, await v.documentFile(req.user, req.params.id, req.params.i))));

// Admin.
const admin = requireRole('admin', 'super_admin');
router.put('/admin/countries', admin, wrap(async (req, res) => ok(res, await v.saveRule(req.user, req.body || {}), 'Country rules saved.')));
router.delete('/admin/countries/:code', admin, wrap(async (req, res) => ok(res, await v.deleteRule(req.params.code), 'Removed.')));
router.patch('/admin/consultants/:id', admin, wrap(async (req, res) => ok(res, await v.setConsultant(req.user, req.params.id, req.body || {}), 'Saved.')));
router.get('/admin/agents', admin, wrap(async (req, res) => ok(res, await v.adminAgents(req.query.q))));
router.get('/admin/cases', admin, wrap(async (req, res) => ok(res, await v.adminCases())));

module.exports = router;
