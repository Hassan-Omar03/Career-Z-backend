const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/onboarding.controller');
const { protect } = require('../middleware/auth');

const uploadLimit = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.get('/requirements', ctrl.requirements);

router.use(protect);
router.get('/status', ctrl.status);
router.get('/history', ctrl.myHistory);
router.post('/account-types', ctrl.addAccountType);
router.patch('/account-types/:role', ctrl.setSubtype);
// Raw file bytes (not JSON/base64) so 10 MB PDFs fit; the type is sniffed from the bytes.
router.post('/documents', uploadLimit, express.raw({ type: () => true, limit: '11mb' }), ctrl.uploadDocument);
router.get('/documents/:id/file', ctrl.documentFile);
router.post('/submit', ctrl.submit);
router.put('/profile', ctrl.saveProfile);

module.exports = router;
