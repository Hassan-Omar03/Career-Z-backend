const router = require('express').Router();
const ctrl = require('../controllers/config.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Public
router.get('/public', ctrl.getPublicConfig);

// Super Admin only
router.use(protect, requireRole('super_admin'));

router.get('/countries', ctrl.listCountries);
router.post('/countries', ctrl.createCountry);
router.patch('/countries/:id', ctrl.updateCountry);

router.get('/languages', ctrl.listLanguages);
router.post('/languages', ctrl.createLanguage);
router.patch('/languages/:id', ctrl.updateLanguage);

router.get('/currencies', ctrl.listCurrencies);
router.post('/currencies', ctrl.createCurrency);
router.patch('/currencies/:id', ctrl.updateCurrency);

router.get('/feature-flags', ctrl.listFeatureFlags);
router.post('/feature-flags', ctrl.upsertFeatureFlag);

module.exports = router;
