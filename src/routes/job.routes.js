const router = require('express').Router();
const ctrl = require('../controllers/job.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public browsing — no login required to search jobs.
router.get('/', optionalAuth, ctrl.listJobs);
router.get('/:id', optionalAuth, ctrl.getJob);

router.use(protect);

// Employer / agent — posting and managing jobs.
router.post('/', requireRole('employer', 'education_agent'), ctrl.createJob);
router.get('/mine/list', requireRole('employer', 'education_agent'), ctrl.myJobs);
router.get('/mine/summary', requireRole('employer', 'education_agent'), ctrl.myJobsSummary);
router.get('/mine/recent-activity', requireRole('employer', 'education_agent'), ctrl.myRecentActivity);
router.patch('/:id', requireRole('employer', 'education_agent'), ctrl.updateJob);
router.get('/:id/applicants', requireRole('employer', 'education_agent'), ctrl.listApplicants);
router.get('/:id/recommended-candidates', requireRole('employer', 'education_agent'), ctrl.listRecommendedCandidates);
router.get('/mine/scheduled-interviews', requireRole('employer', 'education_agent'), ctrl.myScheduledInterviews);
router.post('/:id/shortlist', requireRole('employer', 'education_agent'), ctrl.shortlistCandidate);
router.patch('/applications/:appId/status', requireRole('employer', 'education_agent'), ctrl.updateApplicationStatus);
router.post('/applications/:appId/schedule-interview', requireRole('employer', 'education_agent'), ctrl.scheduleInterview);
router.patch('/interviews/:id', requireRole('employer', 'education_agent'), ctrl.updateInterview);

// Any authenticated user — applying to jobs, and saving jobs for later.
router.post('/:id/apply', ctrl.applyToJob);
router.get('/mine/applications', ctrl.myApplications);
router.get('/mine/saved', ctrl.listSavedJobs);
router.get('/mine/interviews', ctrl.myInterviews);
router.get('/mine/dashboard', ctrl.getMyJobDashboard);
router.post('/:id/save', ctrl.saveJob);
router.delete('/:id/save', ctrl.unsaveJob);

module.exports = router;
