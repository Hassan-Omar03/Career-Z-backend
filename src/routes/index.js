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

router.get('/health', (req, res) => res.json({ success: true, message: 'CareerZ API is running.' }));

module.exports = router;
