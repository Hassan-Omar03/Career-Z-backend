const InstitutionApplication = require('../models/InstitutionApplication');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

const PROGRESS_BY_STATUS = { draft: 0, submitted: 25, under_review: 50, documents_required: 60, accepted: 100, rejected: 100 };
function withProgress(app) {
  const obj = typeof app.toObject === 'function' ? app.toObject() : app;
  return { ...obj, admissionProgress: PROGRESS_BY_STATUS[obj.status] ?? 0 };
}

function getStaffEntry(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  if (isOwner) return { isOwner: true, permissions: ['*'] };
  const entry = institution.staff.find((s) => s.user.toString() === userId.toString());
  if (!entry) throw new AppError('You are not staff at this institution.', 403);
  return { isOwner: false, permissions: entry.permissions || [] };
}

// POST /api/institution-applications — a student starts/submits an application.
const createApplication = asyncHandler(async (req, res) => {
  const { institution, program, submit } = req.body;
  if (!institution || !program) throw new AppError('institution and program are required.', 422);

  const inst = await Institution.findById(institution);
  if (!inst) throw new AppError('Institution not found.', 404);

  const application = await InstitutionApplication.create({
    institution, applicant: req.user._id, program,
    status: submit ? 'submitted' : 'draft',
    submittedAt: submit ? new Date() : null
  });

  if (submit) {
    const recipients = [inst.owner, ...inst.staff.map((s) => s.user)];
    await Promise.all(recipients.map((id) => notify(id, {
      title: `New application: ${req.user.fullName} — ${program}`,
      sentBy: req.user._id
    }).catch(() => {})));
  }

  return created(res, application, submit ? 'Application submitted.' : 'Application draft saved.');
});

// PATCH /api/institution-applications/:id/submit — move a draft to submitted.
const submitApplication = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  if (application.applicant.toString() !== req.user._id.toString()) throw new AppError('This is not your application.', 403);

  application.status = 'submitted';
  application.submittedAt = new Date();
  await application.save();

  const recipients = [application.institution.owner, ...application.institution.staff.map((s) => s.user)];
  await Promise.all(recipients.map((id) => notify(id, {
    title: `New application: ${req.user.fullName} — ${application.program}`,
    sentBy: req.user._id
  }).catch(() => {})));

  return ok(res, application, 'Application submitted.');
});

// POST /api/institution-applications/:id/documents — applicant uploads a document (link).
const addDocument = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  if (application.applicant.toString() !== req.user._id.toString()) throw new AppError('This is not your application.', 403);

  const { name, url } = req.body;
  if (!name || !url) throw new AppError('name and url are required.', 422);
  application.documents.push({ name, url, status: 'pending' });
  await application.save();

  const recipients = [application.institution.owner, ...application.institution.staff.map((s) => s.user)];
  await Promise.all(recipients.map((id) => notify(id, {
    title: `${req.user.fullName} uploaded a document: ${name}`,
    body: application.program,
    sentBy: req.user._id
  }).catch(() => {})));

  return ok(res, application, 'Document uploaded.');
});

// GET /api/institution-applications/mine
const myApplications = asyncHandler(async (req, res) => {
  const applications = await InstitutionApplication.find({ applicant: req.user._id })
    .populate('institution', 'name').sort({ createdAt: -1 });
  return ok(res, applications.map(withProgress));
});

// GET /api/institution-applications/institution/:institutionId — representative/owner view.
const listInstitutionApplications = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  getStaffEntry(institution, req.user._id);

  const applications = await InstitutionApplication.find({ institution: institution._id })
    .populate('applicant', 'fullName email')
    .populate('assignedRepresentative', 'fullName')
    .sort({ createdAt: -1 });
  return ok(res, applications.map(withProgress));
});

// PATCH /api/institution-applications/:id — representative reviews/updates.
// Final accept/reject requires the owner, or a staff member with the 'application:approve'
// permission — everything else (under_review, documents_required, notes, assignment) is
// open to any staff member of the institution.
const updateApplication = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  const { isOwner, permissions } = getStaffEntry(application.institution, req.user._id);

  const { status, missingRequirements, assignedRepresentative, notes } = req.body;
  if (status !== undefined) {
    if (!['draft', 'submitted', 'under_review', 'documents_required', 'accepted', 'rejected'].includes(status)) {
      throw new AppError('Invalid status.', 422);
    }
    if (['accepted', 'rejected'].includes(status) && !isOwner && !permissions.includes('application:approve')) {
      throw new AppError('Only the institution owner or a staff member with final-approval permission can accept or reject an application.', 403);
    }
    application.status = status;
    if (['accepted', 'rejected'].includes(status)) application.reviewedBy = req.user._id;
  }
  if (missingRequirements !== undefined) application.missingRequirements = missingRequirements;
  if (assignedRepresentative !== undefined) {
    application.assignedRepresentative = assignedRepresentative || null;
    if (assignedRepresentative) {
      await notify(assignedRepresentative, {
        title: `New application assigned: ${application.program}`,
        body: `${application.institution.name}`,
        sentBy: req.user._id
      }).catch(() => {});
    }
  }
  if (notes !== undefined) application.notes = notes;
  await application.save();

  if (status) {
    const STATUS_LABEL = { submitted: 'Submitted', under_review: 'Under Review', documents_required: 'Documents Required', accepted: 'Accepted', rejected: 'Rejected', draft: 'Draft' };
    await notify(application.applicant, {
      title: `${application.institution.name}: application status — ${STATUS_LABEL[status]}`,
      body: application.program,
      sentBy: req.user._id
    }).catch(() => {});

    // The assigned representative also needs to know if someone else (e.g. the owner,
    // doing the final accept/reject) moved "their" application forward.
    if (application.assignedRepresentative && application.assignedRepresentative.toString() !== req.user._id.toString()) {
      await notify(application.assignedRepresentative, {
        title: `Application status update: ${application.program} — ${STATUS_LABEL[status]}`,
        body: application.institution.name,
        sentBy: req.user._id
      }).catch(() => {});
    }
  }

  return ok(res, withProgress(application), 'Application updated.');
});

module.exports = { createApplication, submitApplication, addDocument, myApplications, listInstitutionApplications, updateApplication };
