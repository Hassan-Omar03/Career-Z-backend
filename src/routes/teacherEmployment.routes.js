const router = require('express').Router();
const ctrl = require('../controllers/teacherEmployment.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/mine', ctrl.myEmployments);
router.get('/:id/contract-link', ctrl.getContractLink);
router.patch('/:id/respond', ctrl.respondToOffer);
router.post('/:id/resign', ctrl.resign);
router.patch('/:id/terminate', ctrl.terminate);
router.patch('/:id/manage', ctrl.updateEmployment);

module.exports = router;
