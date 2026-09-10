const router = require('express').Router();
const ctrl = require('../controllers/institution.controller');
const notificationCtrl = require('../controllers/notification.controller');
const certificateCtrl = require('../controllers/certificate.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.get('/', optionalAuth, ctrl.listInstitutions);
router.get('/:id', optionalAuth, ctrl.getInstitution);
router.get('/:id/campuses', ctrl.listCampuses);
router.get('/:id/class-sections', ctrl.listClassSections);

router.use(protect);

router.post('/', ctrl.registerInstitution);
router.get('/mine/list', ctrl.myInstitutions);
router.get('/mine/staff-roles', ctrl.myStaffRoles);
router.get('/mine/rep-dashboard', ctrl.getRepDashboard);
router.patch('/:id', ctrl.updateInstitution);
router.post('/:id/verification-documents', ctrl.submitVerificationDocuments);
router.patch('/:id/verify', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.reviewVerification);
router.get('/admin/all', requireRole('admin', 'super_admin', 'platform_staff'), ctrl.adminListAll);

router.post('/:id/staff', ctrl.addStaff);
router.delete('/:id/staff/:userId', ctrl.removeStaff);

router.post('/:id/campuses', ctrl.createCampus);
router.post('/:id/class-sections', ctrl.createClassSection);
router.patch('/:id/class-sections/:sectionId', ctrl.updateClassSection);

router.post('/:id/fees', ctrl.createFee);
router.get('/:id/fees', ctrl.listFees);
router.patch('/fees/:feeId/pay', ctrl.markFeePaid);

router.post('/:id/class-sections/:sectionId/timetable', ctrl.createTimetableEntry);
router.get('/:id/class-sections/:sectionId/timetable', ctrl.listTimetable);
router.patch('/timetable/:entryId', ctrl.updateTimetableEntry);
router.delete('/timetable/:entryId', ctrl.deleteTimetableEntry);

router.post('/:id/notifications/broadcast', notificationCtrl.broadcast);

router.post('/:id/certificates', certificateCtrl.issueCertificate);
router.get('/:id/certificates', certificateCtrl.listInstitutionCertificates);

router.get('/:id/teachers', ctrl.listInstitutionTeachers);
router.get('/:id/students', ctrl.listInstitutionStudents);
router.patch('/students/:profileId/status', ctrl.updateStudentStatus);
router.get('/:id/attendance', ctrl.listInstitutionAttendance);

router.post('/:id/payroll', ctrl.createPayslip);
router.get('/:id/payroll', ctrl.listInstitutionPayroll);
router.patch('/payroll/:payslipId/pay', ctrl.markPayslipPaid);

router.get('/:id/reports', ctrl.getInstitutionReports);
router.get('/:id/exams', ctrl.listInstitutionExams);

module.exports = router;
