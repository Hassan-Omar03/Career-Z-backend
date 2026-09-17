const router = require('express').Router();
const ctrl = require('../controllers/translate.controller');

router.get('/config', ctrl.getTranslationConfig);
router.post('/', ctrl.translateBatch);

module.exports = router;
