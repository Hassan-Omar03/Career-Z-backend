const router = require('express').Router();
const ctrl = require('../controllers/parentReputation.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/mine', ctrl.myReputationSummary);
router.get('/disputes/:institutionId', ctrl.listDisputes);
router.post('/disputes', ctrl.submitDispute);
router.patch('/disputes/:id/resolve', ctrl.resolveDispute);
router.get('/:institutionId/:parentId', ctrl.getReputation);

module.exports = router;
