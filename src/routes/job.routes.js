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
// Manual/off-platform record only — real self-service purchases go through the JazzCash checkout
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
// Online interview video room (built-in WebRTC; services/interviewVideo.service.js).
router.get('/interviews/:id/video', require('../utils/asyncHandler')(async (req, res) => {
  const video = require('../services/interviewVideo.service');
  const { interview, host } = await video.access(req.params.id, req.user._id);
  return require('../utils/apiResponse').ok(res, { meeting: { _id: interview._id, title: `Interview: ${interview.job?.title || ''}`, scheduledDate: interview.scheduledDate }, host, iceServers: video.iceServers(req.user._id), policy: { chatAllowed: true, microphoneAllowed: true, screenShareAllowed: true, cameraRequired: false } });
}));

// Any authenticated user — applying to jobs, and saving jobs for later.
router.get('/smart-apply/matches', ctrl.smartApplyMatches);
// Agent ↔ employer (master: commission between agents and employers) and the agent's AI helpers.
const agentWorkCtrl = require('../controllers/agentWork.controller');
router.get('/mine/agent-requests', agentWorkCtrl.employerRequests);
router.get('/mine/agent-commissions', agentWorkCtrl.employerCommissions);
router.patch('/:id/agent-request', agentWorkCtrl.respond);
router.get('/ai/market-trends', require('express-rate-limit')({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false }), agentWorkCtrl.marketTrends);
router.post('/ai/improve-description', require('express-rate-limit')({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false }), agentWorkCtrl.improveDescription);
router.post('/:id/ai/rank-applicants', require('express-rate-limit')({ windowMs: 60000, max: 5, standardHeaders: true, legacyHeaders: false }), agentWorkCtrl.rankApplicants);
router.post('/smart-apply', ctrl.smartApply);
router.post('/:id/apply', ctrl.applyToJob);
router.post('/applications/:appId/confirm-joining', ctrl.confirmJoining);
router.post('/applications/:appId/withdraw', ctrl.withdrawApplication);
router.get('/applications/:appId/cv-file', ctrl.applicationCvFile);
// Offer, offer letter and the application's message thread (services/jobOffer.service.js).
const offers = require('../services/jobOffer.service');
const wrap = require('../utils/asyncHandler'), { ok: okRes } = require('../utils/apiResponse');
router.post('/applications/:appId/offer', wrap(async (req, res) => okRes(res, await offers.makeOffer(req.user, req.params.appId, req.body || {}), 'Offer sent to the candidate.')));
router.post('/applications/:appId/request-offer', wrap(async (req, res) => okRes(res, await offers.requestOffer(req.user, req.params.appId, req.body?.note), 'Offer requested from the institute.')));
router.post('/applications/:appId/forward-offer', wrap(async (req, res) => { const r = await offers.forwardOffer(req.user, req.params.appId); return okRes(res, r.employment, `Sent the ${r.sent.join(' and ')} to the candidate.`); }));
router.post('/applications/:appId/offer-letter', wrap(async (req, res) => okRes(res, await offers.sendOfferLetter(req.user, req.params.appId, req.body || {}), 'Offer letter sent.')));
router.get('/offer-letters/:employmentId/file', wrap(async (req, res) => require('../controllers/resume.controller').sendPrivateFile(res, await offers.offerLetterFile(req.user, req.params.employmentId))));
router.get('/applications/:appId/messages', wrap(async (req, res) => okRes(res, await offers.messages(req.user, req.params.appId))));
router.post('/applications/:appId/messages', wrap(async (req, res) => okRes(res, await offers.postMessage(req.user, req.params.appId, req.body?.text), 'Message sent.')));
router.get('/mine/applications', ctrl.myApplications);
router.get('/mine/saved', ctrl.listSavedJobs);
router.get('/mine/interviews', ctrl.myInterviews);
router.get('/mine/dashboard', ctrl.getMyJobDashboard);
router.post('/:id/save', ctrl.saveJob);
router.delete('/:id/save', ctrl.unsaveJob);

module.exports = router;
