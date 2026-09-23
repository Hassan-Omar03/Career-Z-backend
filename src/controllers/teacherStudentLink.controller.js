const TeacherStudentLink = require('../models/TeacherStudentLink');
const TeacherProfile = require('../models/TeacherProfile');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');
const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const paddleService = require('../services/paddle.service');

function ageFromDob(dob) {
  if (!dob) return null;
  return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

async function assertIndependentVerifiedTeacher(userId) {
  const teacher = await User.findById(userId);
  if (!teacher || !teacher.emailVerified) throw new AppError('Your account must be email-verified to invite students directly.', 403);
  const profile = await TeacherProfile.findOne({ user: userId });
  if (!profile || !profile.independent) {
    throw new AppError('Only an independent teacher (Teacher Profile -> "Teaches independently") can invite students directly.', 403);
  }
  return { teacher, profile };
}

// POST /api/teacher-students/invite — never force-adds anyone; only creates an invitation the
// student (or their guardian, if a minor) must actually consent to.
const inviteStudent = asyncHandler(async (req, res) => {
  await assertIndependentVerifiedTeacher(req.user._id);

  const { studentEmail, courseId, subject, feeAmount, feeCurrency } = req.body;
  if (!studentEmail || !courseId) throw new AppError('studentEmail and courseId are required.', 422);

  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found.', 404);
  if (course.teacher.toString() !== req.user._id.toString()) throw new AppError('You can only invite students to your own course.', 403);
  if (course.institution) throw new AppError('This is an institution course — institution records and independent-teacher records stay separate. Create/use an independent course instead.', 422);

  const student = await User.findOne({ email: studentEmail.toLowerCase().trim() });
  if (!student || !student.roles.includes('student')) throw new AppError('No student account found with that email.', 404);

  const existing = await TeacherStudentLink.findOne({ teacher: req.user._id, student: student._id, course: course._id });
  if (existing && ['invited', 'consent_pending', 'active', 'paused'].includes(existing.status)) {
    throw new AppError('There is already an open invitation/relationship with this student for this course.', 409);
  }

  const profile = await StudentProfile.findOne({ user: student._id });
  const age = ageFromDob(profile?.dateOfBirth);
  const requiresGuardianApproval = age === null || age < 18; // unknown DOB is treated as a minor, conservatively

  const link = await TeacherStudentLink.create({
    teacher: req.user._id, student: student._id, course: course._id, subject: subject || course.subject || '',
    status: 'invited', requiresGuardianApproval,
    feeAmount: feeAmount || null, feeCurrency: feeCurrency || 'USD'
  });

  await notify(student._id, {
    title: `Tuition invitation from ${req.user.fullName}`,
    body: `Subject: ${link.subject || course.title}. Review and respond from Parent Connections / Tutoring.`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, link, 'Invitation sent.');
});

// PATCH /api/teacher-students/:id/respond — the student accepts or declines. Accepting doesn't
// make it active yet if a guardian approval is required first (spec: "Minor student ke liye
// linked parent/guardian approval mandatory ho").
const respondToInvite = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['accepted', 'declined'].includes(decision)) throw new AppError('decision must be accepted or declined.', 422);

  const link = await TeacherStudentLink.findById(req.params.id);
  if (!link) throw new AppError('Invitation not found.', 404);
  if (link.student.toString() !== req.user._id.toString()) throw new AppError('This invitation is not yours to respond to.', 403);
  if (link.status !== 'invited') throw new AppError('This invitation has already been responded to.', 400);

  link.studentRespondedAt = new Date();
  if (decision === 'declined') {
    link.status = 'removed';
    link.endedAt = new Date();
    link.endedBy = req.user._id;
    link.endReason = 'Declined by student';
    await link.save();
    await notify(link.teacher, { title: `${req.user.fullName} declined your invitation`, sentBy: req.user._id }).catch(() => {});
    return ok(res, link, 'Invitation declined.');
  }

  if (link.requiresGuardianApproval) {
    link.status = 'consent_pending';
    await link.save();
    const guardianLinks = await ParentChildLink.find({ student: req.user._id, status: 'approved' });
    for (const g of guardianLinks) {
      await notify(g.parent, {
        title: `Guardian approval needed: tuition with ${(await User.findById(link.teacher))?.fullName || 'a teacher'}`,
        body: 'Your child was invited to independent tutoring and needs your approval.',
        sentBy: req.user._id
      }).catch(() => {});
    }
    return ok(res, link, guardianLinks.length > 0 ? 'Waiting on guardian approval.' : 'Waiting on guardian approval — no linked guardian found yet; ask them to link from Parent Connections.');
  }

  await activateLink(link, req.user._id);
  return ok(res, link, 'Invitation accepted.');
});

async function activateLink(link, actorId) {
  link.status = 'active';
  await link.save();
  await Enrollment.findOneAndUpdate(
    { student: link.student, course: link.course },
    { $setOnInsert: { student: link.student, course: link.course } },
    { upsert: true }
  );
  await notify(link.teacher, { title: 'Tuition relationship is now active', sentBy: actorId }).catch(() => {});
  await notify(link.student, { title: 'Tuition relationship is now active', sentBy: actorId }).catch(() => {});
}

// PATCH /api/teacher-students/:id/guardian-approve — only a parent with a real, approved link to
// this student may act.
const guardianApprove = asyncHandler(async (req, res) => {
  const { approved } = req.body;
  const link = await TeacherStudentLink.findById(req.params.id);
  if (!link) throw new AppError('Invitation not found.', 404);
  if (link.status !== 'consent_pending') throw new AppError('This invitation is not awaiting guardian approval.', 400);

  const guardianLink = await ParentChildLink.findOne({ parent: req.user._id, student: link.student, status: 'approved' });
  if (!guardianLink) throw new AppError('You are not an approved guardian of this student.', 403);

  if (!approved) {
    link.status = 'removed';
    link.endedAt = new Date();
    link.endedBy = req.user._id;
    link.endReason = 'Guardian declined';
    await link.save();
    await notify(link.teacher, { title: 'Guardian declined the tuition invitation', sentBy: req.user._id }).catch(() => {});
    return ok(res, link, 'Declined.');
  }

  link.guardianApprovedBy = req.user._id;
  link.guardianApprovedAt = new Date();
  await activateLink(link, req.user._id);
  return ok(res, link, 'Approved — relationship is now active.');
});

// POST /api/teacher-students/:id/revoke — student or an approved guardian can end it at any time
// (spec: "Student/parent kabhi bhi relationship leave/revoke kar sake").
const revoke = asyncHandler(async (req, res) => {
  const link = await TeacherStudentLink.findById(req.params.id);
  if (!link) throw new AppError('Relationship not found.', 404);

  const isStudent = link.student.toString() === req.user._id.toString();
  const isGuardian = !isStudent && await ParentChildLink.exists({ parent: req.user._id, student: link.student, status: 'approved' });
  if (!isStudent && !isGuardian) throw new AppError('Only the student or an approved guardian can revoke this.', 403);
  if (!['active', 'paused', 'consent_pending'].includes(link.status)) throw new AppError('This relationship cannot be revoked from its current state.', 400);

  link.status = 'removed';
  link.endedAt = new Date();
  link.endedBy = req.user._id;
  link.endReason = req.body.reason || '';
  await link.save();
  await Enrollment.deleteOne({ student: link.student, course: link.course });

  await notify(link.teacher, { title: 'A tuition relationship was ended', body: link.endReason, sentBy: req.user._id }).catch(() => {});
  return ok(res, link, 'Relationship ended.');
});

// PATCH /api/teacher-students/:id/status — teacher-side pause/resume/complete (never a way to
// force students back in — only 'active'<->'paused' and 'active'->'completed').
const setLinkStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['paused', 'active', 'completed'].includes(status)) throw new AppError('status must be paused, active or completed.', 422);

  const link = await TeacherStudentLink.findById(req.params.id);
  if (!link) throw new AppError('Relationship not found.', 404);
  if (link.teacher.toString() !== req.user._id.toString()) throw new AppError('This is not your relationship to manage.', 403);
  if (status === 'active' && link.status !== 'paused') throw new AppError('Can only resume from paused.', 400);
  if (status === 'paused' && link.status !== 'active') throw new AppError('Can only pause from active.', 400);
  if (status === 'completed' && !['active', 'paused'].includes(link.status)) throw new AppError('Can only complete from active/paused.', 400);

  link.status = status;
  if (status === 'completed') { link.endedAt = new Date(); link.endedBy = req.user._id; }
  await link.save();
  await notify(link.student, { title: `Tuition relationship ${status}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, link, `Relationship ${status}.`);
});

// GET /api/teacher-students/mine — teacher's own relationships (invited/active/history).
const myLinksAsTeacher = asyncHandler(async (req, res) => {
  const links = await TeacherStudentLink.find({ teacher: req.user._id }).populate('student', 'fullName email').populate('course', 'title').sort({ createdAt: -1 });
  return ok(res, links);
});

// GET /api/teacher-students/as-student — a student's own invitations/relationships.
const myLinksAsStudent = asyncHandler(async (req, res) => {
  const links = await TeacherStudentLink.find({ student: req.user._id }).populate('teacher', 'fullName email').populate('course', 'title').sort({ createdAt: -1 });
  return ok(res, links);
});

// GET /api/teacher-students/pending-guardian-approval — a parent's own consent_pending queue.
const pendingGuardianApproval = asyncHandler(async (req, res) => {
  const guardianLinks = await ParentChildLink.find({ parent: req.user._id, status: 'approved' }).select('student');
  const studentIds = guardianLinks.map((l) => l.student);
  const links = await TeacherStudentLink.find({ student: { $in: studentIds }, status: 'consent_pending' })
    .populate('teacher', 'fullName email').populate('student', 'fullName').populate('course', 'title');
  return ok(res, links);
});

// POST /api/teacher-students/:id/fee-checkout — optional fee, verified Paddle checkout (spec:
// "Independent teacher fees optional hon aur verified checkout se process hon").
const createFeeCheckout = asyncHandler(async (req, res) => {
  if (!paddleService.isPaddleConfigured()) throw new AppError('Paddle checkout is not configured.', 503);
  const link = await TeacherStudentLink.findById(req.params.id).populate('course', 'title');
  if (!link) throw new AppError('Relationship not found.', 404);
  if (link.student.toString() !== req.user._id.toString()) throw new AppError('Only the student can pay this fee.', 403);
  if (!['active', 'paused'].includes(link.status)) throw new AppError('This relationship is not active.', 400);
  if (!link.feeAmount || link.feeAmount <= 0) throw new AppError('No fee is set for this relationship.', 400);
  if (link.feePaidAt) throw new AppError('This fee has already been paid.', 400);

  const transaction = await paddleService.createTransaction({
    title: `Tuition fee — ${link.course?.title || link.subject}`, amount: link.feeAmount, currencyCode: link.feeCurrency,
    customerEmail: req.user.email,
    metadata: { kind: 'tutoring_fee', linkId: link._id.toString(), studentId: req.user._id.toString() }
  });
  link.paddleTransactionId = transaction.id;
  await link.save();
  return ok(res, { transactionId: transaction.id, status: transaction.status });
});

const syncFeeCheckout = asyncHandler(async (req, res) => {
  const link = await TeacherStudentLink.findById(req.params.id);
  if (!link) throw new AppError('Relationship not found.', 404);
  if (link.student.toString() !== req.user._id.toString()) throw new AppError('Only the student can check this fee.', 403);
  if (!link.feePaidAt && link.paddleTransactionId) {
    const transaction = await paddleService.getTransaction(link.paddleTransactionId);
    if (transaction.status === 'completed') {
      const { handleTutoringFeePaddleCompleted } = require('./webhook.controller');
      await handleTutoringFeePaddleCompleted(transaction);
    }
  }
  const refreshed = await TeacherStudentLink.findById(link._id);
  return ok(res, { paid: Boolean(refreshed.feePaidAt) });
});

module.exports = {
  inviteStudent, respondToInvite, guardianApprove, revoke, setLinkStatus,
  myLinksAsTeacher, myLinksAsStudent, pendingGuardianApproval,
  createFeeCheckout, syncFeeCheckout
};
