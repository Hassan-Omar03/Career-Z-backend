const MagazineSubmission = require('../models/MagazineSubmission');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

async function assertInstitutionStaffOrOwner(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  const teacherProfile = await TeacherProfile.findOne({ user: userId });
  const isTeacherHere = teacherProfile && teacherProfile.institutions.some((i) => i.toString() === institutionId.toString());
  if (!isOwner && !isStaff && !isTeacherHere) throw new AppError('You are not part of this institution.', 403);
  return { isOwner, isStaff, isTeacherHere };
}

// POST /api/magazine (student)
const submit = asyncHandler(async (req, res) => {
  const { title, type, content, imageUrl } = req.body;
  if (!title || !content) throw new AppError('title and content are required.', 422);

  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile || !profile.primaryInstitution) {
    throw new AppError('Connect to an institution before submitting.', 422);
  }

  const submission = await MagazineSubmission.create({
    institution: profile.primaryInstitution,
    student: req.user._id,
    title,
    type: type || 'other',
    content,
    imageUrl: imageUrl || ''
  });
  return created(res, submission, 'Submitted for review.');
});

// GET /api/magazine/mine (student)
const mySubmissions = asyncHandler(async (req, res) => {
  const list = await MagazineSubmission.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, list);
});

// GET /api/magazine/institution (teacher/institution) — review queue, name shown (curators need it).
const institutionSubmissions = asyncHandler(async (req, res) => {
  const { institutionId } = req.query;
  if (!institutionId) throw new AppError('institutionId is required.', 422);
  await assertInstitutionStaffOrOwner(institutionId, req.user._id);

  const list = await MagazineSubmission.find({ institution: institutionId })
    .populate('student', 'fullName')
    .sort({ createdAt: -1 });
  return ok(res, list);
});

// PATCH /api/magazine/:id/review (teacher) — select, reject, or ask for changes.
const review = asyncHandler(async (req, res) => {
  const { status, editorNotes } = req.body;
  if (!['selected', 'rejected', 'changes_requested'].includes(status)) {
    throw new AppError('status must be selected, rejected or changes_requested.', 422);
  }
  if (status === 'changes_requested' && !editorNotes?.trim()) {
    throw new AppError('Explain what needs to change so the student knows what to fix.', 422);
  }

  const submission = await MagazineSubmission.findById(req.params.id);
  if (!submission) throw new AppError('Submission not found.', 404);
  await assertInstitutionStaffOrOwner(submission.institution, req.user._id);

  submission.status = status;
  submission.editorNotes = editorNotes || '';
  submission.reviewedBy = req.user._id;
  await submission.save();

  const titleByStatus = {
    selected: 'Your magazine submission was selected',
    rejected: 'Your magazine submission was reviewed',
    changes_requested: 'Changes requested on your magazine submission'
  };
  await notify(submission.student, {
    title: titleByStatus[status],
    body: editorNotes || submission.title,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, submission, `Submission ${status}.`);
});

// PATCH /api/magazine/:id/resubmit (student, own submission, only while changes were requested)
const resubmit = asyncHandler(async (req, res) => {
  const { title, type, content, imageUrl } = req.body;
  if (!title || !content) throw new AppError('title and content are required.', 422);

  const submission = await MagazineSubmission.findById(req.params.id);
  if (!submission) throw new AppError('Submission not found.', 404);
  if (submission.student.toString() !== req.user._id.toString()) throw new AppError('This is not your submission.', 403);
  if (submission.status !== 'changes_requested') throw new AppError('This submission is not awaiting changes.', 400);

  submission.title = title;
  submission.type = type || submission.type;
  submission.content = content;
  submission.imageUrl = imageUrl || '';
  submission.status = 'submitted';
  await submission.save();

  return ok(res, submission, 'Resubmitted for review.');
});

// PATCH /api/magazine/:id/publish (institution owner/staff only — final publish step)
const publish = asyncHandler(async (req, res) => {
  const submission = await MagazineSubmission.findById(req.params.id);
  if (!submission) throw new AppError('Submission not found.', 404);
  if (submission.status !== 'selected') throw new AppError('Only selected submissions can be published.', 400);

  // Deliberately stricter than the shared "is this person part of the institution" check used
  // elsewhere in this file: per spec ("Teacher selects, Institution publishes"), a staff entry
  // whose role is literally 'teacher' does not count as publish authority — only the owner or
  // non-teaching staff (principal, coordinator, accountant, etc.) can take this final step.
  const institution = await Institution.findById(submission.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === req.user._id.toString();
  const isNonTeachingStaff = institution.staff.some((s) => s.user.toString() === req.user._id.toString() && s.role !== 'teacher');
  if (!isOwner && !isNonTeachingStaff) throw new AppError('Only the institution can publish the magazine.', 403);

  submission.status = 'published';
  await submission.save();

  await notify(submission.student, {
    title: 'Your magazine submission was published!',
    body: submission.title,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, submission, 'Published.');
});

// GET /api/magazine/published (student/parent) — published issue for an institution.
const published = asyncHandler(async (req, res) => {
  let institutionId = req.query.institution;
  if (!institutionId) {
    const profile = await StudentProfile.findOne({ user: req.user._id });
    institutionId = profile?.primaryInstitution;
  }
  if (!institutionId) return ok(res, []);

  const list = await MagazineSubmission.find({ institution: institutionId, status: 'published' })
    .populate('student', 'fullName')
    .sort({ updatedAt: -1 });
  return ok(res, list);
});

module.exports = { submit, mySubmissions, institutionSubmissions, review, resubmit, publish, published };
