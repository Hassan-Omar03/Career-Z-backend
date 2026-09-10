const router = require('express').Router();
const ctrl = require('../controllers/jobAlert.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createAlert);
router.get('/mine', ctrl.myAlerts);
router.delete('/:id', ctrl.deleteAlert);

module.exports = router;
