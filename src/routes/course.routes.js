const router = require('express').Router();
const ctrl = require('../controllers/course.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

// Public
router.get('/', optionalAuth, ctrl.listCourses);
router.get('/:id', optionalAuth, ctrl.getCourse);

router.use(protect);

// Teacher
router.post('/', requirePermission('course:create:own'), ctrl.createCourse);
router.get('/mine/list', requirePermission('course:create:own'), ctrl.myCourses);
router.patch('/:id', requirePermission('course:update:own'), ctrl.updateCourse);
router.post('/:id/lessons', requirePermission('lesson:create:own'), ctrl.addLesson);
router.patch('/lessons/:lessonId', requirePermission('lesson:update:own'), ctrl.updateLesson);
router.patch('/lessons/:lessonId/complete', requirePermission('course:enroll:own'), ctrl.completeLesson);
router.get('/:id/students', requirePermission('course:update:own'), ctrl.listEnrolledStudents);
router.post('/:id/assignments', requirePermission('assignment:create:own'), ctrl.createAssignment);
router.get('/:id/assignments', ctrl.listAssignments);
router.get('/assignments/:assignmentId/submissions', requirePermission('assignment:grade:own'), ctrl.listSubmissions);
router.patch('/submissions/:submissionId/grade', requirePermission('assignment:grade:own'), ctrl.gradeSubmission);
router.post('/:id/results', requirePermission('result:record:own'), ctrl.recordResult);
router.post('/:id/exams', requirePermission('assignment:create:own'), ctrl.createExam);
router.patch('/exams/:examId/publish', requirePermission('assignment:grade:own'), ctrl.publishExam);
router.get('/exams/:examId/submissions', requirePermission('assignment:grade:own'), ctrl.listExamSubmissions);
router.patch('/exam-submissions/:submissionId/grade', requirePermission('assignment:grade:own'), ctrl.gradeExamSubmission);

// Student
router.post('/:id/enroll', requirePermission('course:enroll:own'), ctrl.enroll);
router.post('/assignments/:assignmentId/submit', requirePermission('assignment:submit:own'), ctrl.submitAssignment);
router.post('/exams/:examId/submit', requirePermission('assignment:submit:own'), ctrl.submitExam);

// Shared (teacher sees all + answer key, student sees published + no answer key — controller decides)
router.get('/:id/exams', ctrl.listExams);

module.exports = router;
