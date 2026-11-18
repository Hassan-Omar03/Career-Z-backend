const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth');

const social = require('../controllers/socialAuth.controller');
router.get('/social/providers', social.providers);
router.post('/social/start/:provider', social.start);
router.get('/social/:provider/callback', social.callback);
router.post('/social/:provider/callback', social.callback);
router.post('/social/exchange', social.exchange);
router.post('/social/link', protect, social.link);

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.post('/login/verify-2fa', ctrl.verifyLogin2FA);
router.post('/2fa/totp/setup', protect, ctrl.totpSetup);
router.post('/2fa/totp/enable', protect, ctrl.totpEnable);
router.post('/2fa/totp/disable', protect, ctrl.totpDisable);
router.post('/2fa/totp/backup-codes', protect, ctrl.totpBackupCodes);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);

router.use(protect);
router.get('/me', ctrl.me);
router.post('/verify-email', ctrl.verifyEmail);
router.post('/resend-verification', ctrl.resendVerification);

module.exports = router;
