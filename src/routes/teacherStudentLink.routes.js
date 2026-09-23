const router = require('express').Router();
const ctrl = require('../controllers/teacherStudentLink.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/invite', ctrl.inviteStudent);
router.patch('/:id/respond', ctrl.respondToInvite);
router.patch('/:id/guardian-approve', ctrl.guardianApprove);
router.post('/:id/revoke', ctrl.revoke);
router.patch('/:id/status', ctrl.setLinkStatus);
router.get('/mine', ctrl.myLinksAsTeacher);
router.get('/as-student', ctrl.myLinksAsStudent);
router.get('/pending-guardian-approval', ctrl.pendingGuardianApproval);
router.post('/:id/fee-checkout', ctrl.createFeeCheckout);
router.get('/:id/fee-checkout/sync', ctrl.syncFeeCheckout);

module.exports = router;
