const router = require('express').Router();
const { protect } = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const pay = require('../services/employerPayroll.service');

router.use(protect);
// Employee side.
router.get('/mine', wrap(async (req, res) => ok(res, await pay.mine(req.user))));
router.patch('/mine/:id/confirm', wrap(async (req, res) => ok(res, await pay.confirm(req.user, req.params.id, req.body || {}), 'Thank you.')));
// Employer (or finance staff with ?employer= / body.employer).
router.get('/', wrap(async (req, res) => ok(res, await pay.month(req.user, req.query))));
router.post('/', wrap(async (req, res) => ok(res, await pay.save(req.user, req.body || {}), 'Payslip saved.')));
router.post('/:id/issue', wrap(async (req, res) => ok(res, await pay.issue(req.user, req.params.id, req.body?.employer), 'Payslip sent to the employee.')));
router.post('/:id/paid', wrap(async (req, res) => ok(res, await pay.markPaid(req.user, req.params.id, req.body || {}), 'Marked as paid.')));
router.delete('/:id', wrap(async (req, res) => ok(res, await pay.remove(req.user, req.params.id, req.query.employer), 'Draft deleted.')));

module.exports = router;
