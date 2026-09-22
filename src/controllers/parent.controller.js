const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Result = require('../models/Result');
const Fee = require('../models/Fee');
const StudentProfile = require('../models/StudentProfile');
const TimetableEntry = require('../models/TimetableEntry');
const Submission = require('../models/Submission');
const Enrollment = require('../models/Enrollment');
const Exam = require('../models/Exam');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
const ParentPermission = require('../models/ParentPermission');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { generateTransactionId } = require('../utils/transactionId');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const { notify } = require('../services/notification.service');

const PAYMENT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', card: 'Card', mobile_wallet: 'Mobile Wallet', cash: 'Cash', other: 'Other'
};
const FEE_COMMISSION_KEY = 'fee_commission_percent';

function ageFromDob(dob) {
  if (!dob) return null;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

// POST /api/parents/link-requests - parent requests to link a student by email
const requestLink = asyncHandler(async (req, res) => {
  const { studentEmail, relationship } = req.body;
  if (!studentEmail) throw new AppError('studentEmail is required.', 422);

  const student = await User.findOne({ email: studentEmail.toLowerCase() });
  if (!student) throw new AppError('No user found with that email.', 404);
  if (!student.roles.includes('student')) throw new AppError('That account is not a student account.', 400);

  const existing = await ParentChildLink.findOne({ parent: req.user._id, student: student._id });
  if (existing) throw new AppError('A link request already exists for this student.', 409);

  const link = await ParentChildLink.create({
    parent: req.user._id,
    student: student._id,
    relationship: relationship || 'guardian',
    requestedBy: req.user._id
  });

  return created(res, link, 'Link request sent. Awaiting student/institution approval.');
});

// GET /api/parents/children - approved links only
const myChildren = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' })
    .populate('student', 'fullName email');
  return ok(res, links);
});

// GET /api/parents/link-requests - all of my requests (any status)
const myLinkRequests = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id }).populate('student', 'fullName email');
  return ok(res, links);
});

// GET /api/parents/incoming-requests - requests where the current user is the student being linked
const incomingRequests = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ student: req.user._id, status: 'pending' })
    .populate('parent', 'fullName email');
  return ok(res, links);
});

// PATCH /api/parents/link-requests/:id/respond - the student approves/rejects
const respondToLink = asyncHandler(async (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('Decision must be approved or rejected.', 422);

  const link = await ParentChildLink.findById(req.params.id);
  if (!link) throw new AppError('Link request not found.', 404);
  if (link.student.toString() !== req.user._id.toString()) {
    throw new AppError('Only the student can respond to this request.', 403);
  }
  if (link.status !== 'pending') throw new AppError('This request has already been responded to.', 400);

  link.status = decision;
  if (decision === 'approved') link.approvedAt = new Date();
  await link.save();

  return ok(res, link, `Link request ${decision}.`);
});

function assertApprovedLink(links, studentId) {
  const found = links.find((l) => l.student.toString() === studentId);
  if (!found) throw new AppError('You are not linked to this student.', 403);
  return found;
}

// A 'sponsor' link (spec Part 11 — a financial supporter, not a legal guardian) is deliberately
// weaker than father/mother/guardian: they can monitor academics and pay fees (that's the point
// of sponsoring), but they are not the legally responsible parent, so they cannot edit medical
// records or sign consent for trips/events/medical treatment on the child's behalf.
const GUARDIAN_RELATIONSHIPS = ['father', 'mother', 'guardian'];

function assertGuardianLink(links, studentId) {
  const found = assertApprovedLink(links, studentId);
  if (!GUARDIAN_RELATIONSHIPS.includes(found.relationship)) {
    throw new AppError('Only a father, mother or guardian link can do this — a sponsor link is view/pay-only.', 403);
  }
  return found;
}

// GET /api/parents/children/:studentId/attendance
const childAttendance = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const records = await Attendance.find({ 'records.student': req.params.studentId }).sort({ date: -1 }).lean();
  return ok(res, records.map((entry) => ({
    ...entry,
    records: entry.records.filter((record) => record.student.toString() === req.params.studentId)
  })));
});

// GET /api/parents/children/:studentId/results
const childResults = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const results = await Result.find({ student: req.params.studentId }).sort({ createdAt: -1 });
  return ok(res, results);
});

// GET /api/parents/children/:studentId/fees
const childFees = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const fees = await Fee.find({ student: req.params.studentId }).sort({ createdAt: -1 });
  return ok(res, fees);
});

// GET /api/parents/children/:studentId/timetable
const childTimetable = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const profile = await StudentProfile.findOne({ user: req.params.studentId });
  if (!profile || !profile.classSection) return ok(res, []);

  const entries = await TimetableEntry.find({ classSection: profile.classSection })
    .populate('teacher', 'fullName')
    .sort({ dayOfWeek: 1, startTime: 1 });
  return ok(res, entries);
});

// GET /api/parents/children/:studentId/homework
const childHomework = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const submissions = await Submission.find({ student: req.params.studentId })
    .populate('assignment', 'title dueDate maxMarks')
    .sort({ createdAt: -1 });
  return ok(res, submissions);
});

// GET /api/parents/children/:studentId/exams — Exam Schedule page (every published exam,
// not just the home page's next-3 preview).
const childExams = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const courseIds = await Enrollment.find({ student: req.params.studentId }).distinct('course');
  const exams = await Exam.find({ course: { $in: courseIds }, published: true })
    .populate('course', 'title subject')
    .sort({ scheduledDate: 1 });
  return ok(res, exams);
});

// PATCH /api/parents/children/:studentId/fees/:feeId/pay — report a manual payment
// for institution verification. Gateway payments use their own checkout endpoints.
const payChildFee = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const { paymentMethod } = req.body;
  if (!paymentMethod || !PAYMENT_METHOD_LABEL[paymentMethod]) {
    throw new AppError('A valid paymentMethod is required (bank_transfer, card, mobile_wallet, cash or other).', 422);
  }

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.student.toString() !== req.params.studentId) throw new AppError('This fee does not belong to that child.', 400);
  if (fee.status === 'paid') throw new AppError('This fee has already been paid.', 400);

  if (paymentMethod === 'card') throw new AppError('Use the secure payment checkout for card payments.', 422);
  if (fee.status === 'processing') throw new AppError('Payment is already awaiting institution confirmation.', 409);

  fee.status = 'processing';
  fee.paymentMethod = paymentMethod;
  fee.paidVia = PAYMENT_METHOD_LABEL[paymentMethod];
  fee.paidBy = req.user._id;
  await fee.save();

  const institution = await Institution.findById(fee.institution);
  if (institution) {
    await notify(institution.owner, {
      title: `Fee payment awaiting verification: ${fee.currency} ${fee.amount} — ${fee.title}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, fee, 'Payment reported. Awaiting institution confirmation.');
});

// GET /api/parents/children/:studentId/health — Health Record (spec Part 11.13). Only the
// linked parent and authorized institution staff can see this; it never appears anywhere public.
// Guardian-only (father/mother/guardian) — a sponsor link cannot view medical information.
const getChildHealth = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertGuardianLink(links, req.params.studentId);

  const profile = await StudentProfile.findOne({ user: req.params.studentId });
  return ok(res, {
    bloodGroup: profile?.bloodGroup || '',
    allergies: profile?.allergies || [],
    medicalNotes: profile?.medicalNotes || '',
    emergencyContact: profile?.emergencyContact || { name: '', phone: '', relation: '' }
  });
});

// PATCH /api/parents/children/:studentId/health — guardian-only.
const updateChildHealth = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertGuardianLink(links, req.params.studentId);

  const allowed = ['bloodGroup', 'allergies', 'medicalNotes', 'emergencyContact'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const profile = await StudentProfile.findOneAndUpdate(
    { user: req.params.studentId },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, profile, 'Health record updated.');
});

// GET /api/parents/children/:studentId/permissions — digital permission slips (spec 11.14).
// Listing is fine for a sponsor to see what's on file, but only a guardian can create one.
const listChildPermissions = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const permissions = await ParentPermission.find({ student: req.params.studentId, parent: req.user._id }).sort({ createdAt: -1 });
  return ok(res, permissions);
});

// POST /api/parents/children/:studentId/permissions — grant or deny consent, with a typed
// e-signature (full name), for a specific activity (trip, event, photo use, medical, etc.).
// Guardian-only — legal consent cannot be signed by a sponsor link.
const grantChildPermission = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertGuardianLink(links, req.params.studentId);

  const { type, title, details, decision, signedName } = req.body;
  const validTypes = ['trip', 'event', 'competition', 'photo', 'medical', 'other'];
  if (!type || !validTypes.includes(type)) throw new AppError('A valid type is required.', 422);
  if (!title) throw new AppError('title is required.', 422);
  if (!['granted', 'denied'].includes(decision)) throw new AppError('decision must be granted or denied.', 422);
  if (!signedName || !signedName.trim()) throw new AppError('Your typed signature (full name) is required.', 422);

  const permission = await ParentPermission.create({
    student: req.params.studentId,
    parent: req.user._id,
    type, title, details: details || '', decision,
    signedName: signedName.trim(),
    signedAt: new Date()
  });

  return created(res, permission, `Permission ${decision}.`);
});

// GET /api/parents/children/:studentId/certificates — Digital Portfolio page.
const childCertificates = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const certificates = await Certificate.find({ student: req.params.studentId })
    .populate('institution', 'name')
    .sort({ issueDate: -1 });
  return ok(res, certificates);
});

// GET /api/parents/me/dashboard — the parent home page's single aggregation call:
// one card per linked child (today's attendance, upcoming exams, fee summary, latest
// teacher message), plus a recent-notifications preview. Full per-module detail lives
// on the separate My Children/Attendance/Fees/etc. pages, same pattern as the student dashboard.
const getMyDashboard = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' }).populate('student', 'fullName profilePhoto');

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

  const children = await Promise.all(links.map(async (link) => {
    const student = link.student;
    const profile = await StudentProfile.findOne({ user: student._id })
      .populate('primaryInstitution', 'name')
      .populate({ path: 'classSection', populate: { path: 'classTeacher', select: 'fullName' } });

    // Today's attendance — find the record for this student inside today's attendance sheets.
    const todayAttendance = await Attendance.findOne({
      'records.student': student._id,
      date: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ createdAt: -1 });
    const myRecord = todayAttendance?.records.find((r) => r.student.toString() === student._id.toString());

    // Upcoming exams across every course this child is enrolled in.
    const courseIds = await Enrollment.find({ student: student._id }).distinct('course');
    const upcomingExams = await Exam.find({
      course: { $in: courseIds }, published: true, scheduledDate: { $gte: new Date() }
    }).populate('course', 'title subject').sort({ scheduledDate: 1 }).limit(3);

    // Fees grouped per institution (a child can be enrolled at more than one).
    const fees = await Fee.find({ student: student._id }).populate('institution', 'name').sort({ dueDate: 1 });
    const byInstitution = {};
    fees.forEach((f) => {
      const key = f.institution?._id?.toString() || 'unknown';
      if (!byInstitution[key]) {
        byInstitution[key] = { institution: f.institution?.name || 'Unknown institution', currency: f.currency, total: 0, paid: 0, dueDate: null, status: 'paid' };
      }
      const g = byInstitution[key];
      g.total += f.amount;
      if (f.status === 'paid') g.paid += f.amount;
      if (f.status !== 'paid' && (!g.dueDate || (f.dueDate && f.dueDate < g.dueDate))) g.dueDate = f.dueDate;
      if (f.status === 'overdue') g.status = 'overdue';
      else if (f.status === 'pending' && g.status !== 'overdue') g.status = 'pending';
    });
    const feesByInstitution = Object.values(byInstitution).map((g) => ({ ...g, remaining: g.total - g.paid }));

    // Latest message with this child's class teacher (the model has no per-child tagging,
    // so we key off the class teacher relationship, which is the parent's real point of contact).
    let teacherMessage = null;
    const classTeacherId = profile?.classSection?.classTeacher?._id;
    if (classTeacherId) {
      const latest = await Message.findOne({
        $or: [{ from: classTeacherId, to: req.user._id }, { from: req.user._id, to: classTeacherId }]
      }).sort({ createdAt: -1 });
      if (latest) {
        const unreadCount = await Message.countDocuments({ from: classTeacherId, to: req.user._id, read: false });
        teacherMessage = {
          teacherName: profile.classSection.classTeacher.fullName,
          text: latest.text,
          date: latest.createdAt,
          unread: unreadCount
        };
      }
    }

    return {
      id: student._id,
      name: student.fullName,
      profilePhoto: student.profilePhoto,
      age: ageFromDob(profile?.dateOfBirth),
      class: profile?.classSection?.name || '',
      program: profile?.program || '',
      currentTerm: profile?.currentTerm || '',
      school: profile?.primaryInstitution?.name || '',
      institutionId: profile?.primaryInstitution?._id || null,
      rollNumber: profile?.rollNumber || '',
      classTeacher: profile?.classSection?.classTeacher?.fullName || '',
      todayAttendance: myRecord ? { status: myRecord.status, reason: myRecord.reason || '' } : null,
      upcomingExams: upcomingExams.map((e) => ({
        id: e._id, subject: e.course?.subject || '', title: e.title, courseTitle: e.course?.title || '',
        scheduledDate: e.scheduledDate, venue: e.venue || '', instructions: e.instructions || ''
      })),
      fees: feesByInstitution,
      teacherMessage
    };
  }));

  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(8);

  return ok(res, { children, notifications });
});

module.exports = {
  requestLink,
  myChildren,
  myLinkRequests,
  incomingRequests,
  respondToLink,
  childAttendance,
  childResults,
  childFees,
  payChildFee,
  childTimetable,
  childHomework,
  childExams,
  childCertificates,
  getChildHealth,
  updateChildHealth,
  listChildPermissions,
  grantChildPermission,
  getMyDashboard
};
