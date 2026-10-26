const router = require('express').Router();
const ctrl = require('../controllers/recruitment.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/agents', ctrl.listAgents);
router.get('/agent-profile', ctrl.myAgentProfile);
router.put('/agent-profile', ctrl.saveAgentProfile);

router.get('/requests', ctrl.listRequests);
router.post('/requests', ctrl.createRequest);
router.post('/requests/:id/respond', ctrl.respond);
router.post('/requests/:id/messages', ctrl.message);
router.post('/requests/:id/cancel', ctrl.cancel);
router.get('/requests/:id/agreements', ctrl.agreements);
router.post('/requests/:id/agreements', ctrl.propose);

router.post('/agreements/:id/accept', ctrl.accept);
router.post('/agreements/:id/decline', ctrl.decline);
router.post('/agreements/:id/end', ctrl.end);

router.get('/hires', ctrl.hires);
router.get('/candidates', ctrl.candidates);
router.post('/candidates/:appId/select', ctrl.selectCandidate);
router.post('/hires/:appId/confirm', ctrl.confirmHire);
router.post('/hires/:appId/decline', ctrl.declineHire);

router.get('/invoices', ctrl.invoices);
router.get('/invoices/:id', ctrl.invoiceDetail);
router.post('/invoices/:id/pay-wallet', ctrl.payWallet);
router.post('/invoices/:id/proof', ctrl.submitProof);
router.get('/invoices/:id/proofs/:proofId', ctrl.proof);
router.post('/invoices/:id/left', ctrl.reportLeft);
router.post('/invoices/:id/replaced', ctrl.replacementDone);
router.post('/invoices/:id/escalate', ctrl.escalate);

module.exports = router;
