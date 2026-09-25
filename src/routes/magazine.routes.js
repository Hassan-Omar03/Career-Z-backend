const router = require('express').Router();
const ctrl = require('../controllers/magazine.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.post('/', requireRole('student'), ctrl.submit);
router.get('/mine', requireRole('student'), ctrl.mySubmissions);
router.patch('/:id/resubmit', requireRole('student'), ctrl.resubmit);

router.get('/institution', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.institutionSubmissions);
router.patch('/:id/review', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.review);
router.patch('/:id/publish', requireRole('institution_owner', 'institution_staff', 'academy_owner'), ctrl.publish);

router.get('/published', ctrl.published);

module.exports = router;
