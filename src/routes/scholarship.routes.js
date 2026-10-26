const router = require('express').Router();
const ctrl = require('../controllers/scholarship.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required.
router.get('/', optionalAuth, ctrl.listScholarships);
// The documents a donor can ask for (before '/:id', which would capture the word).
router.get('/document-types', (req, res) => res.json({ success: true, message: 'OK', data: require('../config/scholarshipApplication').DOCUMENTS }));
router.get('/:id', optionalAuth, ctrl.getScholarship);

router.use(protect);

// Agent listings for providers, and the donor's confirmation of one naming them.
const agentListing = require('../controllers/agentScholarship.controller');
router.post('/agent', requireRole('education_agent'), agentListing.create);
router.get('/agent/mine', requireRole('education_agent'), agentListing.mine);
router.patch('/agent/:id', requireRole('education_agent'), agentListing.update);
router.post('/:id/donor-confirm', requireRole('donor'), agentListing.donorConfirm);

router.get('/received/sponsorship-payments', ctrl.receivedSponsorshipPayments);
router.patch('/received/sponsorships/:id/payments/:paymentId', ctrl.verifySponsorshipPayment);

// Admin — oversight across every donor's scholarships.
router.get('/admin/all', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.adminListAll);

// Donor — posting and managing scholarships.
router.post('/', requireRole('donor'), ctrl.createScholarship);
router.get('/mine/list', requireRole('donor'), ctrl.myScholarships);
// Donor AI (master: best applications, impact report, giving forecast); the donor's own AI key.
const donorAi = require('../controllers/donorWork.controller');
const aiLimit = require('express-rate-limit')({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false });
router.get('/mine/forecast', requireRole('donor'), aiLimit, donorAi.forecast);
router.get('/mine/impact', requireRole('donor'), aiLimit, donorAi.impactReport);
router.post('/:id/ai/rank-applications', requireRole('donor'), aiLimit, donorAi.rankApplications);
router.get('/mine/summary', requireRole('donor'), ctrl.myScholarshipsSummary);
router.get('/mine/sponsorships', requireRole('donor'), ctrl.mySponsorships);
router.get('/mine/deposits', requireRole('donor'), ctrl.myDeposits);
router.post('/donor/deposit', requireRole('donor'), ctrl.requestDeposit);
router.patch('/sponsorships/:id/status', requireRole('donor'), ctrl.updateSponsorshipStatus);
router.patch('/sponsorships/:id/payment', requireRole('donor'), ctrl.recordSponsorshipPayment);
router.patch('/:id', requireRole('donor'), ctrl.updateScholarship);
router.get('/:id/applicants', requireRole('donor'), ctrl.listApplicants);
router.patch('/applications/:appId/status', requireRole('donor'), ctrl.updateApplicationStatus);

// Admin — confirms/rejects a donor's deposit request.
router.patch('/deposits/:id/status', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.updateDepositStatus);
router.get('/admin/deposits', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.adminListDeposits);

// Any authenticated user — applying.
router.get('/:id/apply-form', ctrl.applyForm);
router.post('/:id/documents', require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test' }), ctrl.uploadDocument);
router.get('/applications/:appId/documents/:fileId', ctrl.applicationDocument);
router.post('/:id/apply', ctrl.applyToScholarship);
router.get('/mine/applications', ctrl.myApplications);

module.exports = router;
