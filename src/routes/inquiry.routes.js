const router = require('express').Router();
const ctrl = require('../controllers/inquiry.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', ctrl.createInquiry);
router.get('/mine', ctrl.myInquiries);
router.get('/institution/:institutionId', ctrl.listInstitutionInquiries);
router.patch('/:id', ctrl.updateInquiry);
router.post('/:id/respond', ctrl.respondToInquiry);

module.exports = router;
