const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const staffCtrl = require('../controllers/staff.controller');
const backupCtrl = require('../controllers/backup.controller');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');

router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));

// Sensitive financial data — gated by department for platform_staff (admin/super_admin bypass).
router.get('/finance', requireDepartment('finance'), ctrl.getFinanceSummary);
router.get('/institution-fee-commission-rate', requireDepartment('finance'), ctrl.getInstitutionFeeCommissionRate);
router.patch('/institution-fee-commission-rate', requireRole('super_admin'), ctrl.setInstitutionFeeCommissionRate);

// Read-only platform overview — any staff member can see it.
router.get('/reports', ctrl.getPlatformReports);
router.get('/dashboard', ctrl.getDashboard);
router.get('/world-map', ctrl.getWorldMap);

// Staff team management — Super Admin only.
router.get('/staff', requireRole('super_admin'), staffCtrl.listStaff);
router.post('/staff', requireRole('super_admin'), staffCtrl.addStaff);
router.patch('/staff/:id', requireRole('super_admin'), staffCtrl.updateStaff);
router.delete('/staff/:id', requireRole('super_admin'), staffCtrl.removeStaff);

// Backups — Super Admin only; this touches the entire database, never delegated to staff.
router.get('/backups', requireRole('super_admin'), backupCtrl.listBackups);
router.post('/backups', requireRole('super_admin'), backupCtrl.createBackup);
router.get('/backups/:id/files/:filename', requireRole('super_admin'), backupCtrl.downloadBackupFile);

module.exports = router;
