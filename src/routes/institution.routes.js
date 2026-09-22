const router = require('express').Router();
const ctrl = require('../controllers/institution.controller');
const notificationCtrl = require('../controllers/notification.controller');
const certificateCtrl = require('../controllers/certificate.controller');
const employmentCtrl = require('../controllers/teacherEmployment.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');

router.get('/', optionalAuth, ctrl.listInstitutions);
router.get('/:id', optionalAuth, ctrl.getInstitution);
router.get('/:id/campuses', ctrl.listCampuses);
router.get('/:id/class-sections', ctrl.listClassSections);
router.get('/:id/campus-buildings', ctrl.listCampusBuildings);

router.use(protect);

router.post('/', ctrl.registerInstitution);
router.get('/mine/list', ctrl.myInstitutions);
router.get('/mine/staff-roles', ctrl.myStaffRoles);
router.get('/mine/rep-dashboard', ctrl.getRepDashboard);
router.patch('/:id', ctrl.updateInstitution);
router.post('/:id/verification-documents', ctrl.submitVerificationDocuments);
router.patch('/:id/verify', requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('verification'), ctrl.reviewVerification);
router.get('/admin/all', requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('verification'), ctrl.adminListAll);

router.post('/:id/staff', ctrl.addStaff);
router.delete('/:id/staff/:userId', ctrl.removeStaff);
router.patch('/:id/staff/:userId/ai-permissions', ctrl.updateStaffAiPermissions);
router.get('/:id/staff-attendance', ctrl.listStaffAttendance);

router.post('/:id/teacher-offers', employmentCtrl.createOffer);
router.get('/:id/teacher-employments', employmentCtrl.listInstitutionEmployments);

router.post('/:id/campus-buildings', ctrl.createCampusBuilding);
router.patch('/:id/campus-buildings/:buildingId', ctrl.updateCampusBuilding);
router.delete('/:id/campus-buildings/:buildingId', ctrl.deleteCampusBuilding);

router.post('/:id/campuses', ctrl.createCampus);
router.post('/:id/class-sections', ctrl.createClassSection);
router.patch('/:id/class-sections/:sectionId', ctrl.updateClassSection);

router.post('/:id/fees', ctrl.createFee);
router.get('/:id/fees', ctrl.listFees);
router.patch('/fees/:feeId/pay', ctrl.markFeePaid);
router.patch('/fees/:feeId/release', ctrl.releaseFeeEscrow);
router.post('/fees/:feeId/remind', ctrl.remindFee);
router.post('/fees/:feeId/refund/request', ctrl.requestFeeRefund);
router.patch('/fees/:feeId/refund/decide', ctrl.decideFeeRefund);

router.post('/:id/class-sections/:sectionId/timetable', ctrl.createTimetableEntry);
router.get('/:id/class-sections/:sectionId/timetable', ctrl.listTimetable);
router.patch('/timetable/:entryId', ctrl.updateTimetableEntry);
router.delete('/timetable/:entryId', ctrl.deleteTimetableEntry);

router.post('/:id/notifications/broadcast', notificationCtrl.broadcast);
router.get('/:id/comms-credential', notificationCtrl.getCommsStatus);
router.post('/:id/comms-credential', notificationCtrl.saveCommsCredential);
router.delete('/:id/comms-credential', notificationCtrl.removeCommsCredential);

router.post('/:id/certificates', certificateCtrl.issueCertificate);
router.get('/:id/certificates', certificateCtrl.listInstitutionCertificates);

router.get('/:id/teachers', ctrl.listInstitutionTeachers);
router.get('/:id/students', ctrl.listInstitutionStudents);
router.patch('/students/:profileId/status', ctrl.updateStudentStatus);
router.get('/:id/attendance', ctrl.listInstitutionAttendance);

router.get('/:id/parents', ctrl.listInstitutionParents);
router.patch('/:id/parents/:linkId/verify', ctrl.verifyParentLink);
router.get('/:id/feedback', ctrl.getInstitutionFeedback);
router.get('/:id/feedback/summary', ctrl.getInstitutionFeedbackSummary);

router.post('/:id/payroll', ctrl.createPayslip);
router.get('/:id/payroll', ctrl.listInstitutionPayroll);
router.patch('/payroll/:payslipId/pay', ctrl.markPayslipPaid);

router.get('/:id/reports', ctrl.getInstitutionReports);
router.post('/:id/ai-insights', ctrl.getAiInsights);
router.get('/:id/exams', ctrl.listInstitutionExams);

module.exports = router;
