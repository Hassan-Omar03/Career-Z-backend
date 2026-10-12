const router = require('express').Router();
const { protect } = require('../middleware/auth');
const roadmap = require('../controllers/careerRoadmap.controller');
const internship = require('../controllers/internshipCertificate.controller');

router.use(protect);

// Career roadmaps — /api/career-tools/roadmaps
router.get('/roadmaps', roadmap.list);
router.post('/roadmaps', roadmap.create);
router.post('/roadmaps/generate', roadmap.generate);
router.patch('/roadmaps/:id', roadmap.update);
router.patch('/roadmaps/:id/steps/:stepId', roadmap.setStep);
router.delete('/roadmaps/:id', roadmap.remove);

// Internship completion certificates — /api/career-tools/internship-certificates
router.post('/internship-certificates/employer', internship.issueAsEmployer);
router.post('/internship-certificates/institution', internship.issueAsInstitution);
router.get('/internship-certificates/mine', internship.mine);
router.get('/internship-certificates/issued', internship.issued);
router.patch('/internship-certificates/:id/revoke', internship.revoke);

module.exports = router;
