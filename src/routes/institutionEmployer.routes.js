const router = require('express').Router();
const ctrl = require('../controllers/placement.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/institutions', ctrl.institutions);
router.patch('/institutions/:id/staff/:userId/permission', ctrl.permission);
router.get('/institutions/:id/catalogue', ctrl.catalogue);

router.post('/partnerships', ctrl.requestPartnership);
router.patch('/partnerships/:id/respond', ctrl.respondPartnership);
router.patch('/partnerships/:id/end', ctrl.endPartnership);
router.get('/partnerships/mine', ctrl.myPartnerships);

router.post('/referrals', ctrl.createReferral);
router.get('/referrals/mine', ctrl.myReferrals);
router.post('/referrals/:id/apply', ctrl.applyViaReferral);
router.patch('/referrals/:id/decline', ctrl.declineReferral);
router.get('/referrals/institution/:id', ctrl.institutionReferrals);

module.exports = router;
