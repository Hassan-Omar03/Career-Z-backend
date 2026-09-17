const router = require('express').Router();
const ctrl = require('../controllers/newsletter.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.post('/', requireRole('institution_owner', 'institution_staff', 'academy_owner'), ctrl.createNewsletter);
router.get('/mine', requireRole('institution_owner', 'institution_staff', 'academy_owner'), ctrl.myNewsletters);
router.patch('/:id/publish', requireRole('institution_owner', 'institution_staff', 'academy_owner'), ctrl.publishNewsletter);

router.get('/published', ctrl.publishedForMyInstitution);

module.exports = router;
