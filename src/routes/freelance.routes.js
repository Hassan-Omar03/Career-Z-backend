const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const s = require('../services/freelance.service');

const r = (fn, status) => asyncHandler(async (req, res) => (status === 201 ? created : ok)(res, await fn(req)));

// Public catalogue.
router.get('/services', r((q) => s.publicServices(q.query)));
router.get('/services/:id', r((q) => s.publicService(q.params.id)));
router.get('/options', r(() => ({ types: s.TYPES, categories: s.CATEGORIES })));
router.get('/freelancers/:id', r((q) => s.publicFreelancer(q.params.id)));

// Everything else needs a verified account (protect applies the account gate).
router.use(protect);
// Stops one account flooding others with orders, proposals or messages.
const limiter = require('express-rate-limit');
const perUser = (windowMs, max) => limiter({ windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user._id), validate: false });
const creating = perUser(15 * 60000, 60), chatting = perUser(60000, 40);
router.get('/profile/me', r((q) => s.myProfile(q.user)));
router.put('/profile/me', r((q) => s.saveProfile(q.user, q.body)));
router.get('/my/services', r((q) => s.myServices(q.user)));
router.post('/services', creating, r((q) => s.createService(q.user, q.body), 201));
router.patch('/services/:id', r((q) => s.updateService(q.user, q.params.id, q.body)));
router.post('/services/:id/status', r((q) => s.setServiceStatus(q.user, q.params.id, q.body.status)));
router.post('/services/:id/order', creating, r((q) => s.orderService(q.user, q.params.id, q.body), 201));
router.post('/jobs/:jobId/proposals', creating, r((q) => s.propose(q.user, q.params.jobId, q.body), 201));
router.get('/proposals/sent', r((q) => s.myProposals(q.user)));
router.get('/proposals/received', r((q) => s.receivedProposals(q.user)));
router.post('/proposals/:id/decision', r((q) => s.decideProposal(q.user, q.params.id, q.body.decision)));
router.post('/proposals/:id/withdraw', r((q) => s.withdrawProposal(q.user, q.params.id)));
router.get('/orders', r((q) => s.myOrders(q.user)));
router.get('/orders/:id', r((q) => s.getOrder(q.user, q.params.id)));
router.post('/orders/:id/messages', chatting, r((q) => s.postMessage(q.user, q.params.id, q.body.text)));
router.post('/orders/:id/cancel', r((q) => s.cancelOrder(q.user, q.params.id)));
router.post('/orders/:id/review', r((q) => s.leaveReview(q.user, q.params.id, q.body)));
router.post('/orders/:id/milestones/:mId/submit', r((q) => s.submitWork(q.user, q.params.id, q.params.mId, q.body)));
router.post('/orders/:id/milestones/:mId/approve', r((q) => s.approveWork(q.user, q.params.id, q.params.mId)));
router.post('/orders/:id/milestones/:mId/revision', r((q) => s.askRevision(q.user, q.params.id, q.params.mId, q.body.note)));
router.post('/orders/:id/milestones/:mId/dispute', r((q) => s.openDispute(q.user, q.params.id, q.params.mId, q.body), 201));
router.get('/earnings', r((q) => s.earnings(q.user)));

const admin = requireRole('admin', 'super_admin', 'platform_staff');
router.get('/admin/overview', admin, r(() => s.adminOverview()));
router.post('/admin/services/:id', admin, r((q) => s.adminService(q.user, q.params.id, q.body)));
router.post('/admin/disputes/:id', admin, r((q) => s.resolveDispute(q.user, q.params.id, q.body)));

module.exports = router;
