const router = require('express').Router();
const ctrl = require('../controllers/institutionApplication.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createApplication);
router.post('/offline', ctrl.createOfflineApplication);
router.get('/mine', ctrl.myApplications);
router.get('/institution/:institutionId', ctrl.listInstitutionApplications);
router.patch('/:id/submit', ctrl.submitApplication);
router.post('/:id/documents', ctrl.addDocument);
router.patch('/:id', ctrl.updateApplication);
router.patch('/:id/test', ctrl.setAdmissionTest);
router.patch('/:id/interview', ctrl.setInterview);
router.post('/:id/accept', ctrl.acceptAndEnroll);

module.exports = router;
