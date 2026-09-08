const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/roles', require('./role.routes'));
router.use('/config', require('./config.routes'));
router.use('/institutions', require('./institution.routes'));
router.use('/students', require('./student.routes'));
router.use('/teachers', require('./teacher.routes'));
router.use('/parents', require('./parent.routes'));
router.use('/courses', require('./course.routes'));
router.use('/users', require('./user.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/messages', require('./message.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/jobs', require('./job.routes'));
router.use('/resumes', require('./resume.routes'));
router.use('/certificates', require('./certificate.routes'));
router.use('/marketplace', require('./marketplace.routes'));
router.use('/scholarships', require('./scholarship.routes'));
router.use('/complaints', require('./complaint.routes'));
router.use('/security', require('./security.routes'));
router.use('/admin', require('./admin.routes'));

router.get('/health', (req, res) => res.json({ success: true, message: 'CareerZ API is running.' }));

module.exports = router;
