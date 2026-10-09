const router = require('express').Router();
const ctrl = require('../controllers/questionBank.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/', ctrl.listQuestions);
router.post('/', ctrl.createQuestion);
router.patch('/:id', ctrl.updateQuestion);
router.delete('/:id', ctrl.archiveQuestion);

module.exports = router;
