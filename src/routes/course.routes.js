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
router.get('/:id/students', requirePermission('course:update:own'), ctrl.listEnrolledStudents);
router.post('/:id/assignments', requirePermission('assignment:create:own'), ctrl.createAssignment);
router.get('/:id/assignments', ctrl.listAssignments);
router.get('/assignments/:assignmentId/submissions', requirePermission('assignment:grade:own'), ctrl.listSubmissions);
router.patch('/submissions/:submissionId/grade', requirePermission('assignment:grade:own'), ctrl.gradeSubmission);
router.post('/:id/results', requirePermission('result:record:own'), ctrl.recordResult);

// Student
router.post('/:id/enroll', requirePermission('course:enroll:own'), ctrl.enroll);
router.post('/assignments/:assignmentId/submit', requirePermission('assignment:submit:own'), ctrl.submitAssignment);

module.exports = router;
