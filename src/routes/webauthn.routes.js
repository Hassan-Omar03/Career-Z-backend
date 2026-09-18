const router = require('express').Router();
const ctrl = require('../controllers/webauthn.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/register/options', ctrl.getRegistrationOptions);
router.post('/register/verify', ctrl.verifyRegistration);
router.get('/credentials/mine', ctrl.myCredentials);
router.delete('/credentials/:id', ctrl.removeCredential);

router.get('/attendance/options', ctrl.getAttendanceOptions);
router.post('/attendance/verify', ctrl.verifyAttendance);

module.exports = router;
