const router = require('express').Router();
const ctrl = require('../controllers/job.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required to search jobs.
router.get('/', optionalAuth, ctrl.listJobs);
// Must stay above '/:id' — otherwise "featured-fee" would be captured as an :id value.
router.get('/featured-fee', optionalAuth, ctrl.getFeaturedFee);
// Guest applications (no account). Must stay above '/:id'.
const guest = require('../controllers/guestApplication.controller');
const guestLimiter = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many applications. Please try again later.' } });
router.get('/guest/track', guestLimiter, guest.track);
router.post('/guest/withdraw', guestLimiter, guest.withdraw);
router.post('/guest/confirm-joining', guestLimiter, guest.confirmJoining);
router.post('/:id/guest-apply', guestLimiter, guest.apply);
router.get('/:id', optionalAuth, ctrl.getJob);

router.use(protect);

router.patch('/featured-fee', requireRole('super_admin'), ctrl.setFeaturedFee);
// Manual/off-platform record only — real self-service purchases go through the Paddle checkout
// in payment.routes.js (createFeaturedJobCheckout), which requires an actually-verified charge.
router.post('/:id/feature', requireRole('admin', 'super_admin'), ctrl.featureJob);

// Employer / agent — posting and managing jobs.
// Who may post or manage is decided in the controller (services/jobAccess.service.js): verified
// employers and agents, and verified institutes' owners or recruitment staff.
router.post('/', ctrl.createJob);
router.get('/mine/list', ctrl.myJobs);
router.get('/mine/summary', requireRole('employer', 'education_agent'), ctrl.myJobsSummary);
router.get('/mine/recent-activity', requireRole('employer', 'education_agent'), ctrl.myRecentActivity);
router.patch('/:id', ctrl.updateJob);
router.get('/:id/applicants', ctrl.listApplicants);
router.get('/:id/guest-applicants', guest.list);
router.patch('/guest-applications/:appId/status', guest.status);
router.get('/guest-applications/:appId/cv', guest.cv);
router.get('/:id/recommended-candidates', requireRole('employer', 'education_agent'), ctrl.listRecommendedCandidates);
router.get('/mine/scheduled-interviews', requireRole('employer', 'education_agent'), ctrl.myScheduledInterviews);
router.post('/:id/shortlist', ctrl.shortlistCandidate);
router.patch('/applications/:appId/status', ctrl.updateApplicationStatus);
router.post('/applications/:appId/schedule-interview', ctrl.scheduleInterview);
router.patch('/interviews/:id', ctrl.updateInterview);

// Any authenticated user — applying to jobs, and saving jobs for later.
router.get('/smart-apply/matches', ctrl.smartApplyMatches);
router.post('/smart-apply', ctrl.smartApply);
router.post('/:id/apply', ctrl.applyToJob);
router.post('/applications/:appId/confirm-joining', ctrl.confirmJoining);
router.post('/applications/:appId/withdraw', ctrl.withdrawApplication);
router.get('/mine/applications', ctrl.myApplications);
router.get('/mine/saved', ctrl.listSavedJobs);
router.get('/mine/interviews', ctrl.myInterviews);
router.get('/mine/dashboard', ctrl.getMyJobDashboard);
router.post('/:id/save', ctrl.saveJob);
router.delete('/:id/save', ctrl.unsaveJob);

module.exports = router;
