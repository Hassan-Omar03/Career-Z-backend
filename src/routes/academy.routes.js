const router = require('express').Router();
const { protect } = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const a = require('../services/academy.service');

// Public: an academy's open batches (its page shows them with "Join").
router.get('/institutions/:id/batches', wrap(async (req, res) => ok(res, await a.publicBatches(req.params.id))));

router.use(protect);
// Academy (owner or staff who manage students).
router.get('/institutions/:id/manage', wrap(async (req, res) => ok(res, await a.listBatches(req.user, req.params.id))));
router.post('/institutions/:id/batches', wrap(async (req, res) => created(res, await a.createBatch(req.user, req.params.id, req.body || {}), 'Batch created.')));
router.get('/institutions/:id/report', wrap(async (req, res) => ok(res, await a.report(req.user, req.params.id))));
router.patch('/batches/:id', wrap(async (req, res) => ok(res, await a.updateBatch(req.user, req.params.id, req.body || {}), 'Batch saved.')));
router.get('/batches/:id/students', wrap(async (req, res) => ok(res, await a.roster(req.user, req.params.id))));
router.patch('/enrollments/:id/decide', wrap(async (req, res) => ok(res, await a.decide(req.user, req.params.id, req.body || {}), 'Saved.')));
router.post('/enrollments/:id/remove', wrap(async (req, res) => ok(res, await a.removeStudent(req.user, req.params.id, req.body?.reason), 'Student removed from the batch.')));
// Student.
router.post('/batches/:id/join', wrap(async (req, res) => { const e = await a.join(req.user, req.params.id, req.body?.note); return created(res, e, e.status === 'active' ? 'You have a seat in this batch.' : e.status === 'waitlisted' ? 'The batch is full: you are on the waiting list.' : 'Request sent to the academy.'); }));
router.get('/mine', wrap(async (req, res) => ok(res, await a.mine(req.user))));
router.post('/enrollments/:id/leave', wrap(async (req, res) => ok(res, await a.leave(req.user, req.params.id, req.body?.reason), 'You left the batch.')));
router.post('/enrollments/:id/transfer', wrap(async (req, res) => ok(res, await a.transfer(req.user, req.params.id, req.body?.toBatch), 'Moved to the new batch.')));
// Teacher and parent.
router.get('/teaching', wrap(async (req, res) => ok(res, await a.teaching(req.user))));
router.get('/children/:id', wrap(async (req, res) => ok(res, await a.childBatches(req.user, req.params.id))));

module.exports = router;
