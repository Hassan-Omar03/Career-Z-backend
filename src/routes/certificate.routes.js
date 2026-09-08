const router = require('express').Router();
const ctrl = require('../controllers/certificate.controller');

// Fully public — anyone with the QR code / link can verify a certificate without logging in.
router.get('/verify/:code', ctrl.verifyCertificate);

module.exports = router;
