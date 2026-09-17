const router = require('express').Router();
const ctrl = require('../controllers/resume.controller');
const { protect } = require('../middleware/auth');

// Public — no login required to view a shared Career Portfolio link.
router.get('/public/:userId', ctrl.getPublicResume);

router.use(protect);

router.get('/me', ctrl.getMyResume);
router.patch('/me', ctrl.updateMyResume);

module.exports = router;
