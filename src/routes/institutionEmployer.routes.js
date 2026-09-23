const router = require('express').Router();
const ctrl = require('../controllers/institutionEmployer.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/partnerships', ctrl.requestPartnership);
router.patch('/partnerships/:id/respond', ctrl.respondPartnership);
router.get('/partnerships/mine', ctrl.myPartnerships);

router.post('/referrals', ctrl.createReferral);
router.get('/referrals/mine', ctrl.myReferrals);
router.post('/referrals/:id/apply', ctrl.applyViaReferral);
router.get('/referrals/institution/:id', ctrl.institutionReferrals);

module.exports = router;
