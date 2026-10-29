const router = require('express').Router();
const { protect } = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const svc = require('../services/mockInterview.service');

// AI Mock Interview: practice sessions on the candidate's own AI key.
router.use(protect);
router.get('/', wrap(async (req, res) => ok(res, await svc.mine(req.user))));
router.post('/', wrap(async (req, res) => created(res, await svc.start(req.user, req.body || {}), 'Practice interview ready.')));
router.get('/:id', wrap(async (req, res) => ok(res, await svc.get(req.user, req.params.id))));
router.post('/:id/answer', wrap(async (req, res) => ok(res, await svc.answer(req.user, req.params.id, req.body || {}))));
router.post('/:id/finish', wrap(async (req, res) => ok(res, await svc.finish(req.user, req.params.id), 'Interview report ready.')));
router.delete('/:id', wrap(async (req, res) => ok(res, await svc.remove(req.user, req.params.id), 'Deleted.')));

module.exports = router;
