const router = require('express').Router();
const { protect } = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const staff = require('../services/employerStaff.service');

router.use(protect);

router.get('/roles', (req, res) => ok(res, { roles: staff.ROLES, permissions: staff.PERMISSIONS }));
// Employer side.
router.get('/', wrap(async (req, res) => ok(res, await staff.list(req.user))));
router.post('/', wrap(async (req, res) => ok(res, await staff.invite(req.user, req.body || {}), 'Invitation sent.')));
router.patch('/:id', wrap(async (req, res) => ok(res, await staff.update(req.user, req.params.id, req.body || {}), 'Staff member updated.')));
router.delete('/:id', wrap(async (req, res) => ok(res, await staff.remove(req.user, req.params.id), 'Staff member removed.')));
// Member side.
router.get('/mine/companies', wrap(async (req, res) => ok(res, await staff.mine(req.user))));
router.patch('/mine/:id/respond', wrap(async (req, res) => ok(res, await staff.respond(req.user, req.params.id, req.body?.decision), 'Done.')));
router.post('/mine/:id/leave', wrap(async (req, res) => ok(res, await staff.leave(req.user, req.params.id), 'You left this company.')));

module.exports = router;
