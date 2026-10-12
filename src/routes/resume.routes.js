const router = require('express').Router();
const ctrl = require('../controllers/resume.controller');
const { protect } = require('../middleware/auth');

// Public — no login required to view a shared Career Portfolio link.
router.get('/public/:userId', ctrl.getPublicResume);

router.use(protect);

router.get('/me', ctrl.getMyResume);
router.patch('/me', ctrl.updateMyResume);

// CV autofill from your own records, and named CV versions (max 5).
const variants = require('../controllers/resumeVariant.controller');
router.get('/autofill', variants.preview);
router.post('/me/autofill', variants.fillMain);
router.get('/variants', variants.list);
router.post('/variants', variants.create);
router.patch('/variants/:id', variants.update);
router.post('/variants/:id/autofill', variants.fillVariant);
router.post('/variants/:id/default', variants.makeDefault);
router.delete('/variants/:id', variants.remove);

module.exports = router;
