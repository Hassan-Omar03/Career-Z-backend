const router = require('express').Router();
const ctrl = require('../controllers/complaint.controller');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');

router.use(protect);

router.post('/', ctrl.createComplaint);
router.get('/mine', ctrl.myComplaints);

router.get('/', requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('support'), ctrl.listComplaints);
router.patch('/:id', requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('support'), ctrl.updateComplaintStatus);

module.exports = router;
