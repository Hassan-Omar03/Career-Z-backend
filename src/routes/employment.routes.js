const router = require('express').Router();
const ctrl = require('../controllers/employment.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/mine', ctrl.myEmployments);
router.get('/posted', ctrl.postedEmployments);
router.patch('/:id/respond', ctrl.respondToOffer);
router.post('/:id/resign', ctrl.resign);
router.patch('/:id/terminate', ctrl.terminate);

module.exports = router;
