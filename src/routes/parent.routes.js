const router = require('express').Router();
const ctrl = require('../controllers/parent.controller');
const ptmCtrl = require('../controllers/ptm.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
const proof=require('../controllers/guardianProof.controller');
router.get('/links/:linkId/schools/:institutionId/proof',proof.get);
router.put('/links/:linkId/schools/:institutionId/proof',proof.submit);
router.post('/links/:linkId/schools/:institutionId/proof/review',proof.review);
router.get('/children/:studentId/ai-sources',require('../controllers/familyPolicy.controller').choices);
router.get('/student/teachers',require('../utils/asyncHandler')(async(req,res)=>{if(!(req.accessibleRoles||req.user.roles).includes('student'))throw new (require('../utils/AppError'))('Student role required.',403);return require('../utils/apiResponse').ok(res,await require('../services/familyAccess.service').teachers(req.user._id));}));
router.post('/student/ptm-invitation',require('../controllers/familyStudent.controller').invite);
const cafeteria=require('../controllers/cafeteria.controller');router.get('/children/:studentId/cafeteria',cafeteria.menu);router.post('/children/:studentId/cafeteria/orders',cafeteria.purchase);router.patch('/cafeteria/orders/:orderId',cafeteria.updateOrder);
const family=require('../controllers/family.controller');
const privateFamily=require('../controllers/familyPrivate.controller');
router.get('/private-profile',privateFamily.get);
router.put('/private-profile',privateFamily.save);
router.get('/admin/summary',privateFamily.adminSummary);
router.get('/admin/chat-policy',privateFamily.chatPolicy);router.put('/admin/chat-policy',privateFamily.saveChatPolicy);
router.get('/wallet',family.wallet);
router.get('/children/:studentId/classrooms',family.classrooms);
router.post('/fees/:feeId/wallet-payment',require('../controllers/familyWallet.controller').pay);
router.get('/teaching-roster',family.teachingRoster);
router.get('/children/:studentId/overview',family.overview);
router.post('/consent-requests/:id/respond',family.respondConsent);

router.post('/link-requests', ctrl.requestLink);
router.get('/link-requests', ctrl.myLinkRequests);
router.get('/incoming-requests', ctrl.incomingRequests);
router.patch('/link-requests/:id/respond', ctrl.respondToLink);
router.patch('/link-requests/:id/permissions', ctrl.updateLinkPermissions);
router.delete('/link-requests/:id', ctrl.unlinkChild);

router.get('/me/dashboard', ctrl.getMyDashboard);

router.get('/children', ctrl.myChildren);
router.get('/children/:studentId/attendance', ctrl.childAttendance);
router.get('/children/:studentId/results', ctrl.childResults);
router.get('/children/:studentId/fees', ctrl.childFees);
router.get('/children/:studentId/timetable', ctrl.childTimetable);
router.get('/children/:studentId/homework', ctrl.childHomework);
router.get('/children/:studentId/exams', ctrl.childExams);
router.get('/children/:studentId/certificates', ctrl.childCertificates);
router.get('/children/:studentId/health', ctrl.getChildHealth);
router.patch('/children/:studentId/health', ctrl.updateChildHealth);
router.get('/children/:studentId/permissions', ctrl.listChildPermissions);
router.post('/children/:studentId/permissions', ctrl.grantChildPermission);
router.get('/children/:studentId/teachers', ptmCtrl.listChildTeachers);
router.post('/children/:studentId/ai-assistant', ctrl.getAiAssistantInsights);
router.post('/institutions/:institutionId/feedback', ctrl.submitInstitutionFeedback);

module.exports = router;
