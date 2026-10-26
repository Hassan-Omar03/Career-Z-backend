const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const svc = require('../services/agentWork.service');

const employerRequests = asyncHandler(async (req, res) => ok(res, await svc.employerRequests(req.user)));
const employerCommissions = asyncHandler(async (req, res) => ok(res, await svc.employerCommissions(req.user)));
const respond = asyncHandler(async (req, res) => ok(res, await svc.respond(req.user, req.params.id, req.body), req.body.accept ? 'Accepted. The agent was told.' : 'Declined. The agent was told.'));
const improveDescription = asyncHandler(async (req, res) => ok(res, await svc.improveDescription(req.user, req.body)));
const rankApplicants = asyncHandler(async (req, res) => ok(res, await svc.rankApplicants(req.user, req.params.id)));
// Super Admin / admin
const listAgents = asyncHandler(async (req, res) => ok(res, await svc.listAgents(req.query)));
const activity = asyncHandler(async (req, res) => ok(res, await svc.activity(req.params.id)));
const postingBan = asyncHandler(async (req, res) => ok(res, await svc.setPostingBan(req.user, req.params.id, req.body), req.body.banned ? 'Job posting paused.' : 'Posting allowed again.'));
const cancelLicence = asyncHandler(async (req, res) => ok(res, await svc.cancelLicence(req.user, req.params.id, req.body), 'Agent licence cancelled.'));

module.exports = { employerRequests, employerCommissions, respond, improveDescription, rankApplicants, listAgents, activity, postingBan, cancelLicence };
