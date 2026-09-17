const router = require('express').Router();
const ctrl = require('../controllers/cms.controller');
const { protect } = require('../middleware/auth');
const { requireRole, requireDepartment } = require('../middleware/rbac');

const staffGate = [protect, requireRole('admin', 'super_admin', 'platform_staff'), requireDepartment('content')];

// Pages — admin routes registered before the public :slug catch-all.
router.get('/pages/admin/all', ...staffGate, ctrl.adminListPages);
router.post('/pages', ...staffGate, ctrl.createPage);
router.patch('/pages/:id', ...staffGate, ctrl.updatePage);
router.delete('/pages/:id', ...staffGate, ctrl.deletePage);
router.get('/pages', ctrl.listPublishedPages);
router.get('/pages/:slug', ctrl.getPublishedPage);

// Blog posts — same pattern.
router.get('/blog/admin/all', ...staffGate, ctrl.adminListPosts);
router.post('/blog', ...staffGate, ctrl.createPost);
router.patch('/blog/:id', ...staffGate, ctrl.updatePost);
router.delete('/blog/:id', ...staffGate, ctrl.deletePost);
router.get('/blog', ctrl.listPublishedPosts);
router.get('/blog/:slug', ctrl.getPublishedPost);

module.exports = router;
