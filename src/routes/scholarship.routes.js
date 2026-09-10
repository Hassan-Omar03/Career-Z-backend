const router = require('express').Router();
const ctrl = require('../controllers/scholarship.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required.
router.get('/', optionalAuth, ctrl.listScholarships);
router.get('/:id', optionalAuth, ctrl.getScholarship);

router.use(protect);

// Admin — oversight across every donor's scholarships.
router.get('/admin/all', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.adminListAll);

// Donor — posting and managing scholarships.
router.post('/', requireRole('donor'), ctrl.createScholarship);
router.get('/mine/list', requireRole('donor'), ctrl.myScholarships);
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

// Any authenticated user — applying.
router.post('/:id/apply', ctrl.applyToScholarship);
router.get('/mine/applications', ctrl.myApplications);

module.exports = router;
