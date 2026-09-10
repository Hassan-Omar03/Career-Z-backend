const router = require('express').Router();
const ctrl = require('../controllers/fundingRequest.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required. Literal single-segment routes must be registered
// before "/:id" or Express matches them as an id (e.g. "/recommended" -> :id="recommended").
router.get('/', optionalAuth, ctrl.listFundingRequests);
router.get('/recommended', protect, requireRole('donor'), ctrl.listRecommended);
router.get('/applications', protect, requireRole('donor'), ctrl.listApplications);
router.get('/settings/donations-enabled', protect, ctrl.getDonationsEnabled);
router.get('/:id', optionalAuth, ctrl.getFundingRequest);

router.use(protect);
router.patch('/settings/donations-enabled', requireRole('super_admin'), ctrl.setDonationsEnabled);

// Student / institution owner — submitting funding requests.
router.post('/', requireRole('student', 'institution_owner', 'academy_owner'), ctrl.createFundingRequest);
router.get('/mine/list', ctrl.myFundingRequests);

// Donor — donating, saving.
router.post('/:id/donate', requireRole('donor'), ctrl.donate);
router.post('/:id/save', requireRole('donor'), ctrl.saveRequest);
router.delete('/:id/save', requireRole('donor'), ctrl.unsaveRequest);
router.get('/mine/saved', requireRole('donor'), ctrl.listSaved);
router.get('/mine/donations', requireRole('donor'), ctrl.myDonations);
router.patch('/donations/:id/status', requireRole('donor'), ctrl.updateDonationStatus);
router.patch('/:id/application-status', requireRole('donor'), ctrl.updateApplicationStatus);

// Admin — verification.
router.patch('/:id/verify', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.verifyRequest);

module.exports = router;
