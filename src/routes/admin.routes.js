const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const staffCtrl = require('../controllers/staff.controller');
const backupCtrl = require('../controllers/backup.controller');
const verificationCtrl = require('../controllers/verificationAdmin.controller');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');

router.use(protect, requireRole('admin', 'super_admin', 'platform_staff'));

// Sensitive financial data — gated by department for platform_staff (admin/super_admin bypass).
router.get('/finance', requireDepartment('finance'), ctrl.getFinanceSummary);
router.get('/institution-fee-commission-rate', requireDepartment('finance'), ctrl.getInstitutionFeeCommissionRate);
router.patch('/institution-fee-commission-rate', requireRole('super_admin'), ctrl.setInstitutionFeeCommissionRate);
router.get('/commission-rates', requireDepartment('finance'), ctrl.getCommissionRates);
router.patch('/commission-rates', requireRole('super_admin'), ctrl.setCommissionRates);

// AI provider availability — Super Admin controls which BYOK providers users/institutions may connect.
router.get('/ai-providers', ctrl.getAiProviderConfig);
router.patch('/ai-providers', requireRole('super_admin'), ctrl.setAiProviderConfig);
// Homepage assistant: the platform's own AI key (Super Admin only; never sent back to the browser).
const siteAssistant = require('../services/siteAssistant.service');
const wrap = require('../utils/asyncHandler');
router.get('/site-assistant', requireRole('super_admin'), wrap(async (req, res) => require('../utils/apiResponse').ok(res, await siteAssistant.status())));
router.put('/site-assistant', requireRole('super_admin'), wrap(async (req, res) => { try { return require('../utils/apiResponse').ok(res, await siteAssistant.saveCredential(req.body || {}, req.user._id), 'Homepage assistant connected.'); } catch (e) { throw new (require('../utils/AppError'))(e.message, e.statusCode || 500); } }));
router.delete('/site-assistant', requireRole('super_admin'), wrap(async (req, res) => require('../utils/apiResponse').ok(res, await siteAssistant.removeCredential(), 'Homepage assistant disconnected.')));

// Subscription plan pricing/limits — Super Admin controls the business model, everyone else just reads it.
router.get('/subscription-plans', ctrl.getSubscriptionPlanConfig);
router.patch('/subscription-plans', requireRole('super_admin'), ctrl.setSubscriptionPlanConfig);

// Read-only platform overview — any staff member can see it.
router.get('/reports', ctrl.getPlatformReports);
router.get('/dashboard', ctrl.getDashboard);
router.get('/world-map', ctrl.getWorldMap);
router.post('/ai-insights', ctrl.getAiInsights);

// Account verification & approval — admins, or platform_staff in the verification department.
router.get('/verifications', requireDepartment('verification'), verificationCtrl.list);
router.get('/verifications/:id', requireDepartment('verification'), verificationCtrl.detail);
router.post('/verifications/:id/decision', requireDepartment('verification'), verificationCtrl.decision);
// Job Review queue: jobs held by the risk scan (Master 12.5).
const jobReview = require('../controllers/jobModerationAdmin.controller');
router.get('/jobs/review', requireDepartment('verification'), jobReview.listForReview);
router.post('/jobs/:id/decision', requireDepartment('verification'), jobReview.decide);
const agentScholarships = require('../controllers/agentScholarship.controller');
router.get('/scholarships/review', requireDepartment('verification'), agentScholarships.reviewQueue);
router.post('/scholarships/:id/decision', requireDepartment('verification'), agentScholarships.decide);
router.get('/fee-payments', requireDepartment('finance'), require('../controllers/institutionFee.controller').adminFeeQueue);
// Agent management (master: list, activity, verify, suspend, posting ban, licence cancellation).
const agentAdmin = require('../controllers/agentWork.controller');
router.get('/agents', requireRole('admin', 'super_admin'), agentAdmin.listAgents);
router.get('/agents/:id/activity', requireRole('admin', 'super_admin'), agentAdmin.activity);
router.patch('/agents/:id/posting-ban', requireRole('admin', 'super_admin'), agentAdmin.postingBan);
router.post('/agents/:id/cancel-licence', requireRole('super_admin'), agentAdmin.cancelLicence);
// Donor management (master: list, activity, verify, suspend) and the large-donation rule.
const donorAdmin = require('../controllers/donorWork.controller');
router.get('/donors', requireRole('admin', 'super_admin'), donorAdmin.listDonors);
router.get('/donors/:id/activity', requireRole('admin', 'super_admin'), donorAdmin.activity);
router.get('/donation-settings', requireRole('admin', 'super_admin'), donorAdmin.getSettings);
router.put('/donation-settings', requireRole('super_admin'), donorAdmin.saveSettings);
const recruitmentAdmin = require('../controllers/recruitment.controller').admin;
router.get('/recruitment/invoices', requireDepartment('finance'), recruitmentAdmin.listInvoices);
router.get('/recruitment/invoices/:id/proofs/:proofId', requireDepartment('finance'), recruitmentAdmin.proof);
router.post('/recruitment/invoices/:id/verify', requireDepartment('finance'), recruitmentAdmin.verify);
router.post('/recruitment/invoices/:id/review', requireDepartment('finance'), recruitmentAdmin.resolve);
router.get('/recruitment/settings', requireRole('super_admin'), recruitmentAdmin.getSettings);
router.put('/recruitment/settings', requireRole('super_admin'), recruitmentAdmin.saveSettings);

// Staff team management — Super Admin only.
router.get('/staff', requireRole('super_admin'), staffCtrl.listStaff);
router.post('/staff', requireRole('super_admin'), staffCtrl.addStaff);
router.patch('/staff/:id', requireRole('super_admin'), staffCtrl.updateStaff);
router.delete('/staff/:id', requireRole('super_admin'), staffCtrl.removeStaff);

// Backups — Super Admin only; this touches the entire database, never delegated to staff.
router.get('/backups', requireRole('super_admin'), backupCtrl.listBackups);
router.post('/backups', requireRole('super_admin'), backupCtrl.createBackup);
router.get('/backups/:id/files/:filename', requireRole('super_admin'), backupCtrl.downloadBackupFile);
router.get('/backups/:id/uploads', requireRole('super_admin'), backupCtrl.listBackupUploads);
router.get('/backups/:id/uploads/:key', requireRole('super_admin'), backupCtrl.downloadBackupUpload);
router.post('/backups/:id/uploads/restore', requireRole('super_admin'), backupCtrl.restoreBackupUploads);

module.exports = router;
