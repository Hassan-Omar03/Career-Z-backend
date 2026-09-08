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
router.patch('/:id', requireRole('employer', 'education_agent'), ctrl.updateJob);
router.get('/:id/applicants', requireRole('employer', 'education_agent'), ctrl.listApplicants);
router.patch('/applications/:appId/status', requireRole('employer', 'education_agent'), ctrl.updateApplicationStatus);

// Any authenticated user — applying to jobs.
router.post('/:id/apply', ctrl.applyToJob);
router.get('/mine/applications', ctrl.myApplications);

module.exports = router;
