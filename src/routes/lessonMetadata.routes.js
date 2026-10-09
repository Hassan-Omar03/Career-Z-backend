const router = require('express').Router();
const ctrl = require('../controllers/lessonMetadata.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/:lessonId', ctrl.getMetadata);
router.patch('/:lessonId', ctrl.updateMetadata);
router.post('/:lessonId/review', ctrl.markReviewed);

module.exports = router;
