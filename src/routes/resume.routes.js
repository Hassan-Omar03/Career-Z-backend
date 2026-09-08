const router = require('express').Router();
const ctrl = require('../controllers/resume.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/me', ctrl.getMyResume);
router.patch('/me', ctrl.updateMyResume);

module.exports = router;
