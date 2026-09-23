const router = require('express').Router();
const ctrl = require('../controllers/institutionApplication.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createApplication);
router.post('/offline', ctrl.createOfflineApplication);
router.get('/mine', ctrl.myApplications);
router.get('/institution/:institutionId', ctrl.listInstitutionApplications);
router.get('/tests/institution/:institutionId', ctrl.listOnlineTests);
router.post('/tests', ctrl.createOnlineTest);
router.patch('/:id/submit', ctrl.submitApplication);
router.post('/:id/documents', ctrl.addDocument);
router.patch('/:id', ctrl.updateApplication);
router.patch('/:id/test', ctrl.setAdmissionTest);
router.post('/:id/test/assign', ctrl.assignOnlineTest);
router.post('/:id/test/start', ctrl.startOnlineTest);
router.post('/:id/test/submit', ctrl.submitOnlineTest);
router.patch('/:id/interview', ctrl.setInterview);
router.post('/:id/accept', ctrl.acceptAndEnroll);

module.exports = router;
