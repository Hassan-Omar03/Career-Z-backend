const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);

router.use(protect);
router.get('/me', ctrl.me);
router.post('/verify-email', ctrl.verifyEmail);
router.post('/resend-verification', ctrl.resendVerification);

module.exports = router;
