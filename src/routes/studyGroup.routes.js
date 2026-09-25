const router = require('express').Router();
const ctrl = require('../controllers/studyGroup.controller');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(protect);

const TEACHER = requireRole('teacher', 'institution_owner', 'institution_staff', 'academy_owner');
const STUDENT = requireRole('student');

// Teacher management screen (kept above /:id routes so 'teacher' never matches as an :id param).
router.get('/teacher/courses/:courseId', TEACHER, ctrl.teacherCourseGroups);
router.get('/teacher/courses/:courseId/roster', TEACHER, ctrl.teacherCourseRoster);
router.post('/teacher', TEACHER, ctrl.teacherCreateGroup);
router.post('/teacher/ai-generate', TEACHER, ctrl.aiGenerateGroups);
router.patch('/teacher/courses/:courseId/toggle-enabled', TEACHER, ctrl.setStudyGroupsEnabled);

router.get('/', STUDENT, ctrl.listGroups);
router.get('/mine', ctrl.myGroups);
router.post('/', STUDENT, ctrl.createGroup);
router.get('/:id', ctrl.getGroup);
router.delete('/:id', ctrl.deleteGroup);

router.post('/:id/join', STUDENT, ctrl.joinGroup);
router.post('/:id/leave', ctrl.leaveGroup);
router.patch('/:id/requests/:userId', ctrl.decideJoinRequest);
router.patch('/:id/transfer-ownership', ctrl.transferOwnership);
router.patch('/:id/members/add', ctrl.addMember);
router.patch('/:id/members/:userId/remove', ctrl.removeMember);

router.patch('/:id/project', ctrl.setProject);
router.post('/:id/tasks', ctrl.addTask);
router.patch('/:id/tasks/:taskId', ctrl.updateTask);
router.post('/:id/resources', ctrl.addResource);
router.patch('/:id/submission', ctrl.submitAssignment);
router.patch('/:id/contribution', ctrl.setContribution);
router.patch('/:id/marks', TEACHER, ctrl.setMarks);

router.get('/:id/posts', ctrl.listPosts);
router.post('/:id/posts', ctrl.addPost);

module.exports = router;
