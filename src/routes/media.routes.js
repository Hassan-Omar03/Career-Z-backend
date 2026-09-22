const router = require('express').Router();
const ctrl = require('../controllers/media.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/cloudinary/config', ctrl.getConfig);
router.put('/cloudinary/config', ctrl.saveConfig);
router.delete('/cloudinary/config', ctrl.removeConfig);
router.post('/cloudinary/signature', ctrl.getUploadSignature);

router.get('/platform/config', ctrl.getPlatformConfig);
router.post('/platform/signature', ctrl.getPlatformUploadSignature);

module.exports = router;
