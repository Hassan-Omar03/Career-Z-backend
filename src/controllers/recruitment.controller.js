const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok, created } = require('../utils/apiResponse');
const Setting = require('../models/Setting');
const RecruitmentInvoice = require('../models/RecruitmentInvoice');
const svc = require('../services/recruitment.service');

// Institute–Agent recruitment (see recruitment.service for the whole flow).

const listAgents = asyncHandler(async (req, res) => ok(res, await svc.listAgents(req.query)));
const myAgentProfile = asyncHandler(async (req, res) => ok(res, (await require('../models/User').findById(req.user._id).select('agentProfile')).agentProfile || {}));
const saveAgentProfile = asyncHandler(async (req, res) => {
  if (!(req.user.roles || []).includes('education_agent')) throw new AppError('Only agents have a recruitment profile.', 403);
  return ok(res, await svc.saveAgentProfile(req.user, req.body), 'Recruitment profile saved.');
});

const createRequest = asyncHandler(async (req, res) => created(res, await svc.createRequest(req.user, req.body), 'Request sent to the agent.'));
const listRequests = asyncHandler(async (req, res) => ok(res, await svc.listRequests(req.user, req.query)));
const respond = asyncHandler(async (req, res) => ok(res, await svc.respond(req.user, req.params.id, req.body || {}), 'Answer sent.'));
const message = asyncHandler(async (req, res) => ok(res, await svc.addMessage(req.user, req.params.id, req.body?.text), 'Message sent.'));
const cancel = asyncHandler(async (req, res) => ok(res, await svc.cancelRequest(req.user, req.params.id), 'Request cancelled.'));

const agreements = asyncHandler(async (req, res) => ok(res, await svc.agreementsOf(req.user, req.params.id)));
const propose = asyncHandler(async (req, res) => created(res, await svc.proposeTerms(req.user, req.params.id, req.body || {}), 'Terms sent to the other side.'));
const accept = asyncHandler(async (req, res) => {
  const agreement = await svc.acceptTerms(req.user, req.params.id);
  return ok(res, agreement, agreement.status === 'active' ? 'Agreement is active. The agent can now publish its jobs.' : 'Accepted. Waiting for the other side.');
});
const decline = asyncHandler(async (req, res) => ok(res, await svc.declineTerms(req.user, req.params.id, req.body?.note), 'Terms declined.'));
const end = asyncHandler(async (req, res) => ok(res, await svc.endAgreement(req.user, req.params.id), 'Agreement ended.'));

const hires = asyncHandler(async (req, res) => ok(res, await svc.hiresForInstitution(req.user, req.query.institution)));
const confirmHire = asyncHandler(async (req, res) => {
  const { invoice } = await svc.confirmHire(req.user, req.params.appId, req.body || {});
  return ok(res, { invoice }, invoice ? `Joining confirmed. Invoice ${invoice.number} issued.` : 'Joining confirmed.');
});
const declineHire = asyncHandler(async (req, res) => ok(res, await svc.declineHire(req.user, req.params.appId, req.body?.reason), 'Joining not confirmed. The agent was told why.'));

const invoices = asyncHandler(async (req, res) => ok(res, await svc.invoicesFor(req.user, req.query)));
const invoiceDetail = asyncHandler(async (req, res) => {
  const { invoice, isInstitution } = await svc.invoiceForParty(req.user, req.params.id);
  const out = invoice.toObject();
  if (isInstitution) out.payTo = await svc.paymentInstructions();
  return ok(res, out);
});
const submitProof = asyncHandler(async (req, res) => ok(res, await svc.submitProof(req.user, req.params.id, req.body || {}), 'Payment proof sent. An admin will verify it.'));
const sendFile = (res, file) => {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(file.data);
};
const proof = asyncHandler(async (req, res) => sendFile(res, await svc.proofFile(req.user, req.params.id, req.params.proofId)));
const reportLeft = asyncHandler(async (req, res) => ok(res, await svc.reportLeft(req.user, req.params.id, req.body?.reason), 'Reported.'));
const replacementDone = asyncHandler(async (req, res) => ok(res, await svc.replacementDone(req.user, req.params.id, req.body?.note), 'Replacement recorded.'));
const escalate = asyncHandler(async (req, res) => ok(res, await svc.escalate(req.user, req.params.id, req.body?.note), 'Sent to admin review.'));

// ---------------------------------------------------------------- admin
const admin = {
  listInvoices: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.review === '1') filter['replacement.status'] = 'refund_review';
    const list = await RecruitmentInvoice.find(filter).populate('institution', 'name').populate('agent', 'fullName email').sort({ updatedAt: -1 }).limit(300).lean();
    return ok(res, list);
  }),
  proof: asyncHandler(async (req, res) => sendFile(res, await svc.proofFile(req.user, req.params.id, req.params.proofId, true))),
  verify: asyncHandler(async (req, res) => ok(res, await svc.verifyPayment(req.user, req.params.id, req.body || {}), 'Decision saved.')),
  resolve: asyncHandler(async (req, res) => ok(res, await svc.resolveReview(req.user, req.params.id, req.body || {}), 'Decision saved.')),
  getSettings: asyncHandler(async (req, res) => ok(res, await svc.feeSettings())),
  // Platform fee starts at 0%. Institutes pay into CareerZ's account; until the Super Admin enters
  // its bank details no payment details are shown.
  saveSettings: asyncHandler(async (req, res) => {
    const pct = Number(req.body?.platformFeePercent);
    if (!(pct >= 0 && pct <= 100)) throw new AppError('Platform fee must be 0 to 100%.', 422);
    const mode = req.body?.payment?.mode || '';
    if (!['', 'platform'].includes(mode)) throw new AppError('Institutes pay into the CareerZ account only.', 422);
    const instructions = String(req.body?.payment?.instructions || '').slice(0, 2000);
    if (mode === 'platform' && !instructions.trim()) throw new AppError('Enter the CareerZ bank details institutes should pay to.', 422);
    await Setting.findOneAndUpdate({ key: svc.PLATFORM_FEE_KEY }, { value: pct }, { upsert: true });
    await Setting.findOneAndUpdate({ key: svc.PAYMENT_KEY }, { value: { mode, instructions } }, { upsert: true });
    return ok(res, await svc.feeSettings(), 'Recruitment settings saved.');
  })
};

module.exports = {
  listAgents, myAgentProfile, saveAgentProfile, createRequest, listRequests, respond, message, cancel,
  agreements, propose, accept, decline, end, hires, confirmHire, declineHire,
  invoices, invoiceDetail, submitProof, proof, reportLeft, replacementDone, escalate, admin
};
