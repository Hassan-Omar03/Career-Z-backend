const router = require('express').Router();
const ctrl = require('../controllers/ai.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/config', ctrl.getConfig);
router.put('/config', ctrl.saveConfig);
router.delete('/config/:purpose', ctrl.removeConfig);

router.get('/institutions/:id/config', ctrl.getInstitutionConfig);
router.put('/institutions/:id/config', ctrl.saveInstitutionConfig);
router.delete('/institutions/:id/config/:purpose', ctrl.removeInstitutionConfig);

router.post('/generate', ctrl.generate);
router.post('/image', ctrl.image);
router.post('/3d-model', ctrl.create3DModel);
router.get('/3d-model/:taskId', ctrl.get3DModelStatus);
router.post('/voice', ctrl.voice);
router.post('/avatar-video', ctrl.createAvatarVideo);
router.get('/avatar-video/:videoId', ctrl.getAvatarVideoStatus);
router.post('/animation', ctrl.createAnimation);
router.get('/animation/:taskId', ctrl.getAnimationStatus);

module.exports = router;
