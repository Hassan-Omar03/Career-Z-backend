const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const svc = require('../services/donorWork.service');

const rankApplications = asyncHandler(async (req, res) => ok(res, await svc.rankApplications(req.user, req.params.id)));
const forecast = asyncHandler(async (req, res) => ok(res, await svc.forecast(req.user, { ai: req.query.ai === '1' })));
const impactReport = asyncHandler(async (req, res) => ok(res, await svc.impactReport(req.user, { ai: req.query.ai === '1' })));
// Super Admin / admin
const listDonors = asyncHandler(async (req, res) => ok(res, await svc.listDonors(req.query)));
const activity = asyncHandler(async (req, res) => ok(res, await svc.activity(req.params.id)));
const getSettings = asyncHandler(async (req, res) => ok(res, { thresholdPkr: await svc.largeDonationThreshold() }));
const saveSettings = asyncHandler(async (req, res) => ok(res, await svc.setLargeDonationThreshold(req.body.thresholdPkr), 'Saved.'));

module.exports = { rankApplications, forecast, impactReport, listDonors, activity, getSettings, saveSettings };
