const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const pk = require('../services/employerPackages.service');

// Prices are public so employers can compare before signing in.
router.get('/', wrap(async (req, res) => ok(res, await pk.config())));

router.use(protect);
router.get('/mine', wrap(async (req, res) => ok(res, await pk.mine(req.user, req.query.employer))));
router.get('/invoices/:id', wrap(async (req, res) => ok(res, await pk.invoice(req.user, req.params.id))));
router.post('/featured-credit/:jobId', wrap(async (req, res) => ok(res, await pk.useFeaturedCredit(req.user, req.params.jobId, req.body?.employer), 'Job featured with a Hiring Package credit.')));
router.get('/jobs/:id/applicants.csv', wrap(async (req, res) => {
  const { filename, csv } = await pk.applicantsCsv(req.user, req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
}));
router.patch('/admin/config', requireRole('super_admin'), wrap(async (req, res) => ok(res, await pk.setConfig(req.user, req.body || {}), 'Package prices saved.')));
router.get('/admin/sales', requireRole('admin', 'super_admin'), wrap(async (req, res) => ok(res, await pk.adminSales())));

module.exports = router;
