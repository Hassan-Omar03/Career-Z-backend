const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const svc = require('../services/institutionInvite.service');

// Institute email invitations (teachers, staff, students).
// The person invited: open the link, create the account or accept.
const tokenLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
router.get('/invites/:token', tokenLimit, wrap(async (req, res) => ok(res, await svc.preview(req.params.token))));
router.post('/invites/:token/signup', tokenLimit, wrap(async (req, res) => created(res, await svc.signup(req.params.token, req.body || {}, { deviceInfo: req.headers['user-agent'], ip: req.ip }), 'Welcome to CareerZ.')));
router.post('/invites/:token/accept', protect, wrap(async (req, res) => ok(res, await svc.accept(req.user, req.params.token), 'You joined the institute.')));

// The institute.
router.get('/institutions/:id/invites', protect, wrap(async (req, res) => ok(res, await svc.list(req.user, req.params.id, req.query))));
router.post('/institutions/:id/invites', protect, wrap(async (req, res) => ok(res, await svc.send(req.user, req.params.id, req.body || {}))));
router.post('/institutions/:id/invites/:inviteId/resend', protect, wrap(async (req, res) => ok(res, await svc.resend(req.user, req.params.id, req.params.inviteId), 'Invitation sent again.')));
router.delete('/institutions/:id/invites/:inviteId', protect, wrap(async (req, res) => ok(res, await svc.cancel(req.user, req.params.id, req.params.inviteId), 'Invitation cancelled.')));

module.exports = router;
