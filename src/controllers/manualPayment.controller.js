const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const svc = require('../services/manualPayment.service');

// GET  /api/manual-payments/quote/:kind/:id? — amounts and the two accounts to pay
// POST /api/manual-payments/:kind/:id?       — submit both receipts
// The seller's account never leaves the server before CareerZ's fee is confirmed.
const quote = asyncHandler(async (req, res) => {
  const { openKey, refs, ...q } = await svc.quote(req.user, req.params.kind, req.params.id, req.query);
  if (q.seller) { const { _account, ...seller } = q.seller; q.seller = seller; }
  return ok(res, q);
});
const submit = asyncHandler(async (req, res) => created(res, await svc.submit(req.user, req.params.kind, req.params.id, req.body), 'Receipts sent. CareerZ will check them and confirm.'));
const mine = asyncHandler(async (req, res) => ok(res, await svc.mine(req.user)));
const incoming = asyncHandler(async (req, res) => ok(res, await svc.incoming(req.user)));
const confirm = asyncHandler(async (req, res) => ok(res, await svc.confirmReceived(req.user, req.params.id, req.body), 'Thank you. CareerZ was told.'));
const proof = asyncHandler(async (req, res) => require('./resume.controller').sendPrivateFile(res, await svc.proof(req.user, req.params.id, req.params.leg)));
const adminList = asyncHandler(async (req, res) => ok(res, await svc.adminList(req.user, req.query)));
const decide = asyncHandler(async (req, res) => ok(res, await svc.decide(req.user, req.params.id, req.body), req.body.decision === 'approve' ? 'Payment approved.' : 'Payment rejected.'));
const account = asyncHandler(async (req, res) => ok(res, await svc.platformAccount()));
const saveAccount = asyncHandler(async (req, res) => ok(res, await svc.savePlatformAccount(req.body), 'CareerZ payment account saved.'));

module.exports = { quote, submit, mine, incoming, confirm, proof, adminList, decide, account, saveAccount };
