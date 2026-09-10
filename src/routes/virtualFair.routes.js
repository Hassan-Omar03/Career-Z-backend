const router = require('express').Router();
const ctrl = require('../controllers/virtualFair.controller');
const { protect, optionalAuth } = require('../middleware/auth');

router.get('/', optionalAuth, ctrl.listFairs);

router.use(protect);

router.post('/', ctrl.createFair);
router.get('/institution/:institutionId', ctrl.listInstitutionFairs);
router.get('/mine/registered', ctrl.myRegisteredFairs);
router.post('/:id/register', ctrl.registerForFair);

module.exports = router;
