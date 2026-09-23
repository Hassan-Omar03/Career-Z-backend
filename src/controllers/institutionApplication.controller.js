const crypto = require('crypto');
const InstitutionApplication = require('../models/InstitutionApplication');
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const AdmissionTest = require('../models/AdmissionTest');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const { recordJoin } = require('../utils/institutionMembership');

const PROGRESS_BY_STATUS = { draft: 0, submitted: 25, under_review: 50, documents_required: 60, waitlisted: 70, accepted: 100, rejected: 100 };
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
  if (submit && !req.user.emailVerified) {
    throw new AppError('Verify your email before submitting an application (Profile tab).', 403);
  }

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
  if (!req.user.emailVerified) throw new AppError('Verify your email before submitting an application (Profile tab).', 403);

  if (application.status !== 'draft') throw new AppError('Only a draft application can be submitted.', 409);

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

// POST /api/institution-applications/offline (spec 15D.3 "Offline Admission Entry") — front-desk
// staff registers a walk-in applicant who doesn't have (or hasn't used) their own account.
const createOfflineApplication = asyncHandler(async (req, res) => {
  const { institution: institutionId, applicantName, applicantEmail, program } = req.body;
  if (!institutionId || !applicantName || !applicantEmail || !program) {
    throw new AppError('institution, applicantName, applicantEmail and program are required.', 422);
  }
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  getStaffEntry(institution, req.user._id);

  let applicant = await User.findOne({ email: applicantEmail.toLowerCase().trim() });
  if (!applicant) {
    const bcrypt = require('bcryptjs');
    const randomPassword = crypto.randomBytes(12).toString('hex'); // applicant resets via "forgot password" to claim the account
    applicant = await User.create({
      fullName: applicantName,
      email: applicantEmail.toLowerCase().trim(),
      passwordHash: await bcrypt.hash(randomPassword, 10),
      roles: ['student'],
      emailVerified: false
    });
  }

  const application = await InstitutionApplication.create({
    institution: institutionId, applicant: applicant._id, program,
    status: 'submitted', submittedAt: new Date(), source: 'front_desk'
  });

  return created(res, withProgress(application), 'Offline admission entry recorded.');
});

// PATCH /api/institution-applications/:id/test — record/schedule the admission test.
const setAdmissionTest = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  getStaffEntry(application.institution, req.user._id);

  const { scheduledAt, subject, maxScore, score, notes } = req.body;
  if (scheduledAt !== undefined) application.admissionTest.scheduledAt = scheduledAt || null;
  if (subject !== undefined) application.admissionTest.subject = subject;
  if (maxScore !== undefined) application.admissionTest.maxScore = maxScore;
  if (score !== undefined) application.admissionTest.score = score;
  if (notes !== undefined) application.admissionTest.notes = notes;
  await application.save();

  if (scheduledAt) {
    await notify(application.applicant, {
      title: `Admission test scheduled: ${application.institution.name}`,
      body: `${subject || 'Admission test'} — ${new Date(scheduledAt).toLocaleString()}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, withProgress(application), 'Admission test updated.');
});

// Institution-owned reusable online admission tests.
const createOnlineTest = asyncHandler(async (req, res) => {
  const { institution: institutionId, title, program, subject, instructions, durationMinutes, passingPercent, questions, published } = req.body;
  if (!institutionId || !title || !Array.isArray(questions) || questions.length === 0) {
    throw new AppError('institution, title and at least one question are required.', 422);
  }
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  getStaffEntry(institution, req.user._id);
  for (const question of questions) {
    if (!question.text || !Array.isArray(question.options) || question.options.length < 2) throw new AppError('Every question needs text and at least two options.', 422);
    if (!Number.isInteger(Number(question.correctOption)) || Number(question.correctOption) < 0 || Number(question.correctOption) >= question.options.length) throw new AppError('Every question needs a valid correct option.', 422);
  }
  const test = await AdmissionTest.create({ institution: institutionId, createdBy: req.user._id, title, program, subject, instructions, durationMinutes: Number(durationMinutes) || 30, passingPercent: Number(passingPercent) || 50, questions, published: Boolean(published) });
  return created(res, test, 'Online admission test created.');
});

const listOnlineTests = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  getStaffEntry(institution, req.user._id);
  return ok(res, await AdmissionTest.find({ institution: institution._id }).sort({ createdAt: -1 }));
});

const assignOnlineTest = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  getStaffEntry(application.institution, req.user._id);
  const test = await AdmissionTest.findOne({ _id: req.body.testId, institution: application.institution._id, published: true });
  if (!test) throw new AppError('Published admission test not found.', 404);
  const scheduledAt = new Date(req.body.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new AppError('A valid scheduledAt is required.', 422);
  application.admissionTest = { test: test._id, scheduledAt, subject: test.subject, maxScore: test.questions.reduce((sum, q) => sum + q.marks, 0), score: null, notes: '', status: 'scheduled', startedAt: null, submittedAt: null, answers: [] };
  await application.save();
  await notify(application.applicant, { title: `Online admission test scheduled: ${test.title}`, body: `${scheduledAt.toLocaleString()} · ${test.durationMinutes} minutes`, sentBy: req.user._id }).catch(() => {});
  return ok(res, withProgress(application), 'Online admission test assigned.');
});

function publicTest(test) {
  return { _id: test._id, title: test.title, subject: test.subject, instructions: test.instructions, durationMinutes: test.durationMinutes, questions: test.questions.map((q, index) => ({ index, text: q.text, type: q.type, options: q.options, marks: q.marks })) };
}

const startOnlineTest = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('admissionTest.test');
  if (!application) throw new AppError('Application not found.', 404);
  if (application.applicant.toString() !== req.user._id.toString()) throw new AppError('This is not your application.', 403);
  if (!req.user.emailVerified) throw new AppError('Verify your email before starting the admission test (Profile tab).', 403);
  const test = application.admissionTest.test;
  if (!test) throw new AppError('No online test is assigned.', 404);
  const now = new Date();
  if (now < application.admissionTest.scheduledAt) throw new AppError('This test is not open yet.', 409);
  if (['submitted', 'passed', 'failed'].includes(application.admissionTest.status)) throw new AppError('This test has already been submitted.', 409);
  if (!application.admissionTest.startedAt) {
    await InstitutionApplication.updateOne({ _id: application._id }, { $set: { 'admissionTest.startedAt': now, 'admissionTest.status': 'in_progress' } });
    application.admissionTest.startedAt = now;
    application.admissionTest.status = 'in_progress';
  }
  const endsAt = new Date(application.admissionTest.startedAt.getTime() + test.durationMinutes * 60000);
  if (now > endsAt) throw new AppError('The test time has expired. Submit your saved answers.', 410);
  return ok(res, { applicationId: application._id, test: publicTest(test), startedAt: application.admissionTest.startedAt, endsAt });
});

const submitOnlineTest = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('admissionTest.test');
  if (!application) throw new AppError('Application not found.', 404);
  if (application.applicant.toString() !== req.user._id.toString()) throw new AppError('This is not your application.', 403);
  const test = application.admissionTest.test;
  if (!test || !application.admissionTest.startedAt) throw new AppError('Start the assigned test first.', 409);
  if (['submitted', 'passed', 'failed'].includes(application.admissionTest.status)) throw new AppError('This test has already been submitted.', 409);
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const endsAt = new Date(application.admissionTest.startedAt.getTime() + test.durationMinutes * 60000);
  if (Date.now() > endsAt.getTime() + 30000) throw new AppError('The test submission window has expired.', 410);
  const unique = new Map();
  for (const answer of answers) {
    const index = Number(answer.questionIndex);
    const selected = Number(answer.selectedOption);
    if (!Number.isInteger(index) || index < 0 || index >= test.questions.length || unique.has(index)) throw new AppError('Answers contain an invalid or duplicate question.', 422);
    if (!Number.isInteger(selected) || selected < 0 || selected >= test.questions[index].options.length) throw new AppError('An answer contains an invalid option.', 422);
    unique.set(index, selected);
  }
  let score = 0;
  test.questions.forEach((question, index) => { if (unique.get(index) === question.correctOption) score += question.marks; });
  const maxScore = test.questions.reduce((sum, q) => sum + q.marks, 0);
  const percent = maxScore ? Math.round((score / maxScore) * 100) : 0;
  const finalStatus = percent >= test.passingPercent ? 'passed' : 'failed';
  await InstitutionApplication.updateOne({ _id: application._id }, { $set: {
    'admissionTest.answers': [...unique].map(([questionIndex, selectedOption]) => ({ questionIndex, selectedOption })),
    'admissionTest.score': score, 'admissionTest.maxScore': maxScore,
    'admissionTest.submittedAt': new Date(), 'admissionTest.status': finalStatus
  } });
  return ok(res, { score, maxScore, percent, passed: finalStatus === 'passed' }, 'Admission test submitted.');
});

// PATCH /api/institution-applications/:id/interview — schedule/complete the admission interview.
const setInterview = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  getStaffEntry(application.institution, req.user._id);

  const { scheduledAt, mode, interviewer, completed, notes } = req.body;
  if (scheduledAt && application.admissionTest?.test && application.admissionTest.status !== 'passed') {
    throw new AppError('The applicant must pass the assigned online test before an interview is scheduled.', 409);
  }
  if (scheduledAt !== undefined) application.interview.scheduledAt = scheduledAt || null;
  if (mode !== undefined) application.interview.mode = mode;
  if (interviewer !== undefined) application.interview.interviewer = interviewer || null;
  if (completed !== undefined) application.interview.completed = completed;
  if (notes !== undefined) application.interview.notes = notes;
  await application.save();

  if (scheduledAt) {
    await notify(application.applicant, {
      title: `Admission interview scheduled: ${application.institution.name}`,
      body: `${mode || 'Interview'} — ${new Date(scheduledAt).toLocaleString()}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, withProgress(application), 'Interview updated.');
});

// POST /api/institution-applications/:id/accept — final acceptance: generates the Admission
// Letter (verify-code, same pattern as Certificate) and the Student ID (creates/links a real
// StudentProfile with its own idCardCode — spec 15D.3 "Student ID Generation").
const acceptAndEnroll = asyncHandler(async (req, res) => {
  const application = await InstitutionApplication.findById(req.params.id).populate('institution');
  if (!application) throw new AppError('Application not found.', 404);
  const { isOwner, permissions } = getStaffEntry(application.institution, req.user._id);
  if (!isOwner && !permissions.includes('application:approve')) {
    throw new AppError('Only the institution owner or a staff member with final-approval permission can accept.', 403);
  }
  if (application.admissionTest?.test && application.admissionTest.status !== 'passed') {
    throw new AppError('The assigned online admission test must be passed before acceptance.', 409);
  }
  if (application.admissionTest?.test && (!application.interview?.scheduledAt || !application.interview?.completed)) {
    throw new AppError('The admission interview must be completed before acceptance.', 409);
  }

  let profile = await StudentProfile.findOne({ user: application.applicant });

  application.status = 'accepted';
  application.reviewedBy = req.user._id;
  application.admissionLetter = { verifyCode: crypto.randomBytes(8).toString('hex'), issuedAt: new Date() };

  if (!profile) {
    profile = await StudentProfile.create({ user: application.applicant, admissionDate: new Date() });
  }
  // A student can be a real member of more than one institution at once — this records the
  // membership and only touches primaryInstitution if this is their first (or a re-join).
  const membership = await recordJoin(application.applicant, application.institution._id, application.program);
  if (membership.isPrimary) {
    profile.program = application.program;
    profile.admissionDate = profile.admissionDate || new Date();
    await profile.save();
  }
  application.generatedStudentProfile = profile._id;
  await application.save();

  await notify(application.applicant, {
    title: `Congratulations! Admitted to ${application.institution.name}`,
    body: `Your Admission Letter and Student ID (${profile.idCardCode}) are ready in your dashboard.`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, withProgress(application), 'Applicant accepted and enrolled.');
});

module.exports = {
  createApplication, submitApplication, addDocument, myApplications, listInstitutionApplications, updateApplication,
  createOfflineApplication, setAdmissionTest, setInterview, acceptAndEnroll
  ,createOnlineTest, listOnlineTests, assignOnlineTest, startOnlineTest, submitOnlineTest
};
