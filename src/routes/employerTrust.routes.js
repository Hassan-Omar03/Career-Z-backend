const router = require('express').Router();
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const t = require('../services/employerTrust.service');

// Public: a company's trust score and published employee reviews.
router.get('/companies/:id', optionalAuth, wrap(async (req, res) => ok(res, await t.publicProfile(req.params.id))));

router.use(protect);
// Employee reviews.
router.get('/reviews/reviewable', wrap(async (req, res) => ok(res, await t.reviewable(req.user))));
router.get('/reviews/mine', wrap(async (req, res) => ok(res, await t.myReviews(req.user))));
router.post('/reviews', wrap(async (req, res) => { const r = await t.createReview(req.user, req.body || {}); return ok(res, r, r.status === 'published' ? 'Review published.' : 'Review sent for a CareerZ check before it is published.'); }));
router.get('/reviews/employer', requireRole('employer'), wrap(async (req, res) => ok(res, await t.employerReviews(req.user))));
router.get('/reviews/employer/trust', requireRole('employer'), wrap(async (req, res) => ok(res, await t.trustScore(req.user._id))));
router.patch('/reviews/:id/respond', requireRole('employer'), wrap(async (req, res) => ok(res, await t.respond(req.user, req.params.id, req.body?.text), 'Answer published.')));
router.post('/reviews/:id/report', requireRole('employer'), wrap(async (req, res) => ok(res, await t.report(req.user, req.params.id, req.body?.reason), 'Review reported to CareerZ.')));
router.post('/reviews/:id/appeal', wrap(async (req, res) => ok(res, await t.appeal(req.user, req.params.id, req.body?.text), 'Appeal sent.')));
// Fraud reports.
router.get('/fraud-categories', (req, res) => ok(res, t.FRAUD_CATEGORIES));
router.post('/companies/:id/fraud-reports', wrap(async (req, res) => ok(res, await t.reportFraud(req.user, req.params.id, req.body || {}), 'Report sent to CareerZ.')));
router.get('/fraud-reports/mine', wrap(async (req, res) => ok(res, await t.myFraudReports(req.user))));
router.post('/fraud-reports/:id/evidence', wrap(async (req, res) => ok(res, await t.addEvidence(req.user, req.params.id, req.body?.note), 'Evidence added.')));

// Super Admin / admin.
const admin = requireRole('admin', 'super_admin');
router.get('/admin/overview', admin, wrap(async (req, res) => ok(res, await t.adminOverview())));
router.get('/admin/employers', admin, wrap(async (req, res) => ok(res, await t.adminEmployers(req.query))));
router.post('/admin/employers/:id/lift', admin, wrap(async (req, res) => ok(res, await t.adminLift(req.user, req.params.id, req.body?.note), 'Restriction lifted.')));
router.get('/admin/reviews', admin, wrap(async (req, res) => ok(res, await t.adminQueue())));
router.patch('/admin/reviews/:id', admin, wrap(async (req, res) => ok(res, await t.adminDecide(req.user, req.params.id, req.body || {}), 'Decision saved.')));
router.patch('/admin/reviews/:id/appeal', admin, wrap(async (req, res) => ok(res, await t.adminDecideAppeal(req.user, req.params.id, req.body || {}), 'Appeal decided.')));
router.post('/admin/reviews/:id/ai-check', admin, wrap(async (req, res) => ok(res, await t.adminAiCheck(req.user, req.params.id))));
router.get('/admin/fraud-cases', admin, wrap(async (req, res) => ok(res, await t.adminCases(req.query))));
router.patch('/admin/fraud-cases/:id', admin, wrap(async (req, res) => ok(res, await t.adminDecideCase(req.user, req.params.id, req.body || {}), 'Decision saved.')));
router.post('/admin/fraud-cases/:id/evidence', admin, wrap(async (req, res) => ok(res, await t.addEvidence(req.user, req.params.id, req.body?.note, true), 'Evidence added.')));
router.post('/admin/fraud-cases/:id/authority-report', admin, wrap(async (req, res) => ok(res, await t.adminAuthorityReport(req.user, req.params.id, req.body || {}), 'Authority report recorded.')));

module.exports = router;
