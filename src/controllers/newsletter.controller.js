const Newsletter = require('../models/Newsletter');
const StudentProfile = require('../models/StudentProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

async function assertInstitutionStaffOrOwner(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You are not staff at this institution.', 403);
}

// POST /api/newsletters (institution owner/staff)
const createNewsletter = asyncHandler(async (req, res) => {
  const { institution, title, content } = req.body;
  if (!institution || !title || !content) throw new AppError('institution, title and content are required.', 422);
  await assertInstitutionStaffOrOwner(institution, req.user._id);

  const newsletter = await Newsletter.create({ institution, createdBy: req.user._id, title, content });
  return created(res, newsletter, 'Newsletter saved as draft.');
});

// GET /api/newsletters/mine (institution owner/staff) — drafts + published for their institutions.
const myNewsletters = asyncHandler(async (req, res) => {
  const { institution } = req.query;
  const filter = { createdBy: req.user._id };
  if (institution) filter.institution = institution;
  const list = await Newsletter.find(filter).sort({ createdAt: -1 });
  return ok(res, list);
});

// PATCH /api/newsletters/:id/publish (institution owner/staff)
const publishNewsletter = asyncHandler(async (req, res) => {
  const newsletter = await Newsletter.findById(req.params.id);
  if (!newsletter) throw new AppError('Newsletter not found.', 404);
  await assertInstitutionStaffOrOwner(newsletter.institution, req.user._id);

  newsletter.status = 'published';
  newsletter.publishedAt = new Date();
  await newsletter.save();
  return ok(res, newsletter, 'Newsletter published.');
});

// GET /api/newsletters/published (student/parent) — published newsletters for the student's institution.
const publishedForMyInstitution = asyncHandler(async (req, res) => {
  let institutionId = req.query.institution;
  if (!institutionId) {
    const profile = await StudentProfile.findOne({ user: req.user._id });
    institutionId = profile?.primaryInstitution;
  }
  if (!institutionId) return ok(res, []);

  const list = await Newsletter.find({ institution: institutionId, status: 'published' }).sort({ publishedAt: -1 });
  return ok(res, list);
});

module.exports = { createNewsletter, myNewsletters, publishNewsletter, publishedForMyInstitution };
