const router = require('express').Router();
const ctrl = require('../controllers/institutionApplication.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createApplication);
router.get('/mine', ctrl.myApplications);
router.get('/institution/:institutionId', ctrl.listInstitutionApplications);
router.patch('/:id/submit', ctrl.submitApplication);
router.post('/:id/documents', ctrl.addDocument);
router.patch('/:id', ctrl.updateApplication);

module.exports = router;
