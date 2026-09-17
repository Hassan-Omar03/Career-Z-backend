const router = require('express').Router();
const ctrl = require('../controllers/anonymousQuestion.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

router.post('/', requireRole('student'), ctrl.createQuestion);
router.get('/mine', requireRole('student'), ctrl.myQuestions);
router.get('/institution', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.institutionQuestions);
router.patch('/:id/answer', requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner'), ctrl.answerQuestion);

module.exports = router;
