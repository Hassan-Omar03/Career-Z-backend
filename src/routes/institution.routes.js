const router = require('express').Router();
const ctrl = require('../controllers/institution.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.get('/', optionalAuth, ctrl.listInstitutions);
router.get('/:id', optionalAuth, ctrl.getInstitution);
router.get('/:id/campuses', ctrl.listCampuses);
router.get('/:id/class-sections', ctrl.listClassSections);

router.use(protect);

router.post('/', ctrl.registerInstitution);
router.get('/mine/list', ctrl.myInstitutions);
router.patch('/:id', ctrl.updateInstitution);
router.post('/:id/verification-documents', ctrl.submitVerificationDocuments);
router.patch('/:id/verify', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.reviewVerification);
router.get('/admin/all', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.adminListAll);

router.post('/:id/staff', ctrl.addStaff);
router.delete('/:id/staff/:userId', ctrl.removeStaff);

router.post('/:id/campuses', ctrl.createCampus);
router.post('/:id/class-sections', ctrl.createClassSection);

module.exports = router;
