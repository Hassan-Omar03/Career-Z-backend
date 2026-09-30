const QRCode = require('qrcode');
const crypto = require('crypto');
const TeacherProfile = require('../models/TeacherProfile');
const Course = require('../models/Course');
const Attendance = require('../models/Attendance');
const AttendanceSession = require('../models/AttendanceSession');
const StaffAttendance = require('../models/StaffAttendance');
const TimetableEntry = require('../models/TimetableEntry');
const Payslip = require('../models/Payslip');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');
const Exam = require('../models/Exam');
const Result = require('../models/Result');
const ClassEngagementRecord = require('../models/ClassEngagementRecord');
const Certificate = require('../models/Certificate');
const StudentGoal = require('../models/StudentGoal');
const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { notify, notifyParentsOfStudent, notifyMany } = require('../services/notification.service');
const { getBlockingInstitutionFee, assertInstitutionFeeAccess } = require('../utils/feeAccess');
const { recalculateEnrollmentProgressForCourse } = require('../utils/courseProgress');
const { getStripeClient, isStripeConfigured } = require('../services/stripe.service');
const env = require('../config/env');

const DOW_BY_JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// GET /api/teachers/me
const getMyProfile = asyncHandler(async (req, res) => {
  let profile = await TeacherProfile.findOne({ user: req.user._id }).populate('institutions', 'name type country');
  if (!profile) profile = await TeacherProfile.create({ user: req.user._id });
  return ok(res, profile);
});

// PATCH /api/teachers/me
const updateMyProfile = asyncHandler(async (req, res) => {
  const allowed = ['subjects', 'qualifications', 'experienceYears', 'bio', 'independent', 'visibleToInstitutions'];
  const update = {};
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

  // A teacher discoverable to institutions with no photo is just a name and a subject list — the
  // frontend already disables this checkbox without a photo, but that's advisory only; this is
  // the actual gate, since the request could otherwise be sent directly.
  if (update.visibleToInstitutions === true && !req.user.profilePhoto) {
    throw new AppError('Add a profile photo before making your profile discoverable to institutions.', 422);
  }

  const profile = await TeacherProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, profile);
});

// GET /api/teachers/me/classes -> distinct class sections derived from the teacher's courses
const getMyClasses = asyncHandler(async (req, res) => {
  const courses = await Course.find({ teacher: req.user._id }).populate('classSection', 'name academicYear');
  const sections = courses
    .map((c) => c.classSection)
    .filter(Boolean)
    .reduce((acc, s) => {
      if (!acc.find((x) => x._id.toString() === s._id.toString())) acc.push(s);
      return acc;
    }, []);
  return ok(res, sections);
});

// POST /api/teachers/me/attendance
const markAttendance = asyncHandler(async (req, res) => {
  const { institution, course, classSection, date, records } = req.body;
  if (!course || !date || !Array.isArray(records) || records.length === 0) {
    throw new AppError('course, date and a non-empty records array are required.', 422);
  }

  // If tied to a course, verify ownership.
  if (course) {
    const courseDoc = await Course.findById(course);
    if (!courseDoc) throw new AppError('Course not found.', 404);
    if (courseDoc.teacher.toString() !== req.user._id.toString()) {
      throw new AppError('You do not teach this course.', 403);
    }
    if (institution && courseDoc.institution && courseDoc.institution.toString() !== institution.toString()) {
      throw new AppError('Course does not belong to this institution.', 422);
    }
    if (classSection && courseDoc.classSection && courseDoc.classSection.toString() !== classSection.toString()) {
      throw new AppError('Course does not belong to this class section.', 422);
    }
    const studentIds = records.map((record) => record.student?.toString());
    if (studentIds.some((id) => !id) || new Set(studentIds).size !== studentIds.length) {
      throw new AppError('Each attendance record needs a distinct student.', 422);
    }
    const enrolled = await Enrollment.find({ course, student: { $in: studentIds } }).distinct('student');
    if (enrolled.length !== studentIds.length) throw new AppError('Attendance can only include enrolled students.', 403);
    const presentIds = records.filter((record) => record.status !== 'absent').map((record) => record.student);
    const blockers = await Promise.all(presentIds.map((studentId) => getBlockingInstitutionFee(studentId, courseDoc.institution)));
    if (blockers.some(Boolean)) throw new AppError('A student with a due fee cannot be marked present. Record payment first or mark that student absent.', 402);
  }

  const attendance = await Attendance.create({
    institution: institution || null,
    course: course || null,
    classSection: classSection || null,
    date,
    markedBy: req.user._id,
    records
  });
  if (course) await recalculateEnrollmentProgressForCourse(course).catch(() => {});

  // Parent dashboard's "Child absent" notification — fired the moment attendance goes in.
  const absentIds = records.filter((r) => r.status === 'absent').map((r) => r.student);
  if (absentIds.length > 0) {
    const absentStudents = await User.find({ _id: { $in: absentIds } }).select('fullName');
    await Promise.all(absentStudents.map((s) => notifyParentsOfStudent(s._id, {
      title: `${s.fullName} was marked absent today`,
      body: new Date(date).toLocaleDateString(),
      sentBy: req.user._id
    }).catch(() => {})));
  }

  return ok(res, attendance, 'Attendance recorded.');
});

// POST /api/teachers/me/attendance/qr-session — real session-based QR attendance. The teacher
// generates ONE short-lived QR for the whole class (shown on screen/shared); each enrolled
// student scans it with their own device and checks themselves in. The QR encodes only a random
// one-time token, never a student's permanent Digital ID — and the token expires after a few
// minutes, so a screenshotted/reused old QR stops working once the session closes.
const createQrSession = asyncHandler(async (req, res) => {
  const { course, date, minutesValid } = req.body;
  if (!course || !date) throw new AppError('course and date are required.', 422);

  const courseDoc = await Course.findById(course);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  if (courseDoc.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);

  const expiresAt = new Date(Date.now() + (Number(minutesValid) || 10) * 60 * 1000);
  const session = await AttendanceSession.create({
    course, classSection: courseDoc.classSection, createdBy: req.user._id, date, expiresAt
  });

  const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ t: session.token }));

  // Physical classrooms don't need this (students see the projected QR directly), but a remote/
  // online student has no other way to know a session just opened — so every enrolled student
  // gets the join code pushed to them the moment it's created.
  const enrolledIds = await Enrollment.find({ course }).distinct('student');
  if (enrolledIds.length > 0) {
    await notifyMany(enrolledIds, {
      title: `Attendance session open: ${courseDoc.title}`,
      body: `Enter code ${session.code} in Attendance > Scan Teacher QR, or scan the QR on your teacher's screen. Expires ${expiresAt.toLocaleTimeString()}.`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, { sessionId: session._id, qrDataUrl, sessionCode: session.code, expiresAt, checkedIn: 0 }, 'QR session started.');
});

// GET /api/teachers/me/attendance/qr-session/:id — live check-in count while the QR is displayed.
const getQrSession = asyncHandler(async (req, res) => {
  const session = await AttendanceSession.findById(req.params.id).populate('checkedIn', 'fullName');
  if (!session) throw new AppError('Session not found.', 404);
  if (session.createdBy.toString() !== req.user._id.toString()) throw new AppError('Not your session.', 403);
  return ok(res, {
    checkedIn: session.checkedIn.map((s) => s.fullName),
    expiresAt: session.expiresAt,
    active: session.expiresAt > new Date()
  });
});

// PATCH /api/teachers/me/courses/:id/attendance-location — GPS attendance is optional per
// course (spec: optional, since it needs the student's browser/device location permission).
const setAttendanceLocation = asyncHandler(async (req, res) => {
  const courseDoc = await Course.findById(req.params.id);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  if (courseDoc.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);

  const { enabled, lat, lng, radiusMeters } = req.body;
  if (enabled && (lat === undefined || lng === undefined)) throw new AppError('lat and lng are required to enable GPS attendance.', 422);

  courseDoc.attendanceLocation = {
    enabled: Boolean(enabled),
    lat: enabled ? Number(lat) : courseDoc.attendanceLocation.lat,
    lng: enabled ? Number(lng) : courseDoc.attendanceLocation.lng,
    radiusMeters: radiusMeters ? Number(radiusMeters) : (courseDoc.attendanceLocation.radiusMeters || 150)
  };
  await courseDoc.save();
  return ok(res, courseDoc.attendanceLocation, 'Attendance location updated.');
});

// POST /api/teachers/me/attendance/face-scan — the teacher's browser already ran face
// matching locally (face-api.js against enrolled descriptors from
// GET /courses/:id/face-descriptors) and identified a real enrolled studentId; this just
// records the result the same way markAttendanceByQr does. This server never performs face
// recognition itself.
const markAttendanceByFace = asyncHandler(async (req, res) => {
  const { studentId, course, date } = req.body;
  if (!studentId || !course || !date) throw new AppError('studentId, course and date are required.', 422);

  const courseDoc = await Course.findById(course);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  if (courseDoc.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);

  const enrolled = await Enrollment.findOne({ course, student: studentId });
  if (!enrolled) throw new AppError('That student is not enrolled in this course.', 400);
  await assertInstitutionFeeAccess(studentId, courseDoc.institution);

  const student = await User.findById(studentId).select('fullName');
  if (!student) throw new AppError('Student not found.', 404);

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);

  let sheet = await Attendance.findOne({ course, date: { $gte: dayStart, $lte: dayEnd }, markedBy: req.user._id });
  if (!sheet) {
    sheet = await Attendance.create({ institution: courseDoc.institution, course, classSection: courseDoc.classSection, date, markedBy: req.user._id, records: [] });
  }

  const already = sheet.records.find((r) => r.student.toString() === studentId);
  if (already) {
    return ok(res, { studentName: student.fullName, alreadyMarked: true }, `${student.fullName} was already marked present today.`);
  }

  sheet.records.push({ student: studentId, status: 'present', method: 'face', checkedInAt: new Date() });
  await sheet.save();
  await recalculateEnrollmentProgressForCourse(course).catch(() => {});
  return ok(res, { studentName: student.fullName, alreadyMarked: false }, `${student.fullName} marked present.`);
});

// GET /api/teachers/me/attendance/face-requests?course=&date= — pending remote face check-ins
// (student is not physically in front of the teacher's own camera — see markAttendanceByFace's
// comment for why that path only works in person).
const listFaceCheckInRequests = asyncHandler(async (req, res) => {
  const FaceCheckInRequest = require('../models/FaceCheckInRequest');
  const { course, date } = req.query;
  if (!course || !date) throw new AppError('course and date are required.', 422);
  const courseDoc = await Course.findById(course);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  if (courseDoc.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  const requests = await FaceCheckInRequest.find({ course, date: { $gte: dayStart, $lte: dayEnd }, status: 'pending' })
    .populate('student', 'fullName profilePhoto')
    .sort({ createdAt: 1 });
  return ok(res, requests);
});

// PATCH /api/teachers/me/attendance/face-requests/:id — teacher approves/rejects a remote face
// check-in. Approving is what actually creates the real Attendance record.
const reviewFaceCheckInRequest = asyncHandler(async (req, res) => {
  const FaceCheckInRequest = require('../models/FaceCheckInRequest');
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);

  const request = await FaceCheckInRequest.findById(req.params.id).populate('student', 'fullName');
  if (!request) throw new AppError('Request not found.', 404);
  const courseDoc = await Course.findById(request.course);
  if (!courseDoc || courseDoc.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not teach this course.', 403);
  if (request.status !== 'pending') throw new AppError('This request has already been reviewed.', 409);

  request.status = decision;
  request.reviewedBy = req.user._id;
  request.reviewedAt = new Date();
  await request.save();

  if (decision === 'approved') {
    await assertInstitutionFeeAccess(request.student._id, courseDoc.institution);
    const dayStart = new Date(request.date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(request.date); dayEnd.setHours(23, 59, 59, 999);
    let sheet = await Attendance.findOne({ course: request.course, date: { $gte: dayStart, $lte: dayEnd }, markedBy: req.user._id });
    if (!sheet) {
      sheet = await Attendance.create({ institution: courseDoc.institution, course: request.course, classSection: courseDoc.classSection, date: request.date, markedBy: req.user._id, records: [] });
    }
    if (!sheet.records.some((r) => r.student.toString() === request.student._id.toString())) {
      sheet.records.push({ student: request.student._id, status: 'present', method: 'face_remote', checkedInAt: new Date() });
      await sheet.save();
      await recalculateEnrollmentProgressForCourse(request.course).catch(() => {});
    }
  }

  await notify(request.student._id, {
    title: `Remote face check-in ${decision}: ${courseDoc.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, request, `Request ${decision}.`);
});

// GET /api/teachers/me/attendance
const listAttendance = asyncHandler(async (req, res) => {
  const attendance = await Attendance.find({ markedBy: req.user._id }).sort({ date: -1 });
  return ok(res, attendance);
});

// GET /api/teachers/me/timetable
const getMyTimetable = asyncHandler(async (req, res) => {
  const entries = await TimetableEntry.find({ teacher: req.user._id })
    .populate('classSection', 'name academicYear')
    .sort({ dayOfWeek: 1, startTime: 1 });
  return ok(res, entries);
});

// POST /api/teachers/me/self-attendance/check-in — the teacher's own real, timestamped
// check-in (spec 9.9/15D.9). One per calendar day (unique index on staff+date). "Late" is
// computed against this teacher's own first scheduled class today (TimetableEntry), not a
// fabricated rule — if there's no class today, it's always "present".
const checkInMyAttendance = asyncHandler(async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const existing = await StaffAttendance.findOne({ staff: req.user._id, date: today });
  if (existing) throw new AppError('You have already checked in today.', 400);

  const dow = DOW_BY_JS_DAY[new Date().getDay()];
  const firstClass = await TimetableEntry.findOne({ teacher: req.user._id, dayOfWeek: dow }).sort({ startTime: 1 });

  const now = new Date();
  let status = 'present';
  if (firstClass?.startTime) {
    const [h, m] = firstClass.startTime.split(':').map(Number);
    const classStart = new Date(); classStart.setHours(h, m, 0, 0);
    if (now > classStart) status = 'late';
  }

  const profile = await TeacherProfile.findOne({ user: req.user._id });
  const record = await StaffAttendance.create({
    staff: req.user._id,
    institution: profile?.institutions?.[0] || null,
    date: today,
    checkInAt: now,
    status
  });
  return ok(res, record, status === 'late' ? 'Checked in (marked late).' : 'Checked in.');
});

// GET /api/teachers/me/self-attendance
const getMySelfAttendance = asyncHandler(async (req, res) => {
  const records = await StaffAttendance.find({ staff: req.user._id }).sort({ date: -1 }).limit(90);
  return ok(res, records);
});

// GET /api/teachers/me/payslips
const getMyPayslips = asyncHandler(async (req, res) => {
  const payslips = await Payslip.find({ staff: req.user._id })
    .populate('institution', 'name')
    .sort({ year: -1, month: -1 });
  return ok(res, payslips);
});

// PATCH /api/teachers/me/payslips/:id/verify-payment
// A manual salary report becomes paid only after the teacher (the receiver) confirms receipt.
const verifyMyPayslipPayment = asyncHandler(async (req, res) => {
  const payslip = await Payslip.findOne({ _id: req.params.id, staff: req.user._id });
  if (!payslip) throw new AppError('Payslip not found.', 404);
  if (payslip.status !== 'processing') throw new AppError('No manual salary payment is awaiting your verification.', 409);
  const { decision, rejectionReason } = req.body;
  if (decision === 'reject') {
    if (!String(rejectionReason || '').trim()) throw new AppError('A rejection reason is required.', 422);
    payslip.status = 'pending';
    payslip.paymentRejectedAt = new Date();
    payslip.paymentRejectionReason = String(rejectionReason).trim();
    await payslip.save();
    return ok(res, payslip, 'Salary payment report rejected.');
  }
  if (decision !== 'verify') throw new AppError('decision must be verify or reject.', 422);
  payslip.status = 'paid'; payslip.paidAt = new Date();
  payslip.paymentVerifiedAt = new Date(); payslip.paymentVerifiedBy = req.user._id;
  payslip.transactionId = payslip.paymentReference || `SAL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  await payslip.save();
  return ok(res, payslip, 'Salary receipt verified.');
});

// GET /api/teachers/me/dashboard — the Teacher home page's single aggregation call: today's
// classes, today's attendance summary, pending-vs-submitted assignments, upcoming exams,
// salary summary (this teacher's own payslips only) and a recent-notifications preview.
const getMyDashboard = asyncHandler(async (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const today = DOW_BY_JS_DAY[new Date().getDay()];

  const [todayClasses, todayAttendanceSheets, courses, exams, payslips, notifications] = await Promise.all([
    TimetableEntry.find({ teacher: req.user._id, dayOfWeek: today }).populate('classSection', 'name').sort({ startTime: 1 }),
    Attendance.find({ markedBy: req.user._id, date: { $gte: startOfDay, $lte: endOfDay } }),
    Course.find({ teacher: req.user._id }),
    Exam.find({ teacher: req.user._id, published: true, scheduledDate: { $gte: new Date() } }).populate('course', 'title subject').sort({ scheduledDate: 1 }).limit(5),
    Payslip.find({ staff: req.user._id }).sort({ year: -1, month: -1 }),
    Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(8)
  ]);

  // Today's attendance summary — every student marked across every sheet the teacher took today.
  let totalMarked = 0, present = 0, absent = 0;
  todayAttendanceSheets.forEach((sheet) => {
    sheet.records.forEach((r) => {
      totalMarked += 1;
      if (r.status === 'present') present += 1;
      if (r.status === 'absent') absent += 1;
    });
  });

  // Pending vs submitted, across every assignment this teacher has posted.
  const courseIds = courses.map((c) => c._id);
  const assignments = await Assignment.find({ course: { $in: courseIds } });
  const assignmentIds = assignments.map((a) => a._id);
  const [submissions, enrollmentsByCourse] = await Promise.all([
    Submission.find({ assignment: { $in: assignmentIds } }),
    Enrollment.find({ course: { $in: courseIds } })
  ]);
  const enrolledCountByCourse = {};
  enrollmentsByCourse.forEach((e) => {
    const key = e.course.toString();
    enrolledCountByCourse[key] = (enrolledCountByCourse[key] || 0) + 1;
  });
  const submittedCountByAssignment = {};
  submissions.forEach((s) => {
    const key = s.assignment.toString();
    submittedCountByAssignment[key] = (submittedCountByAssignment[key] || 0) + 1;
  });
  let totalSubmitted = 0, totalPending = 0;
  assignments.forEach((a) => {
    const enrolled = enrolledCountByCourse[a.course.toString()] || 0;
    const submitted = submittedCountByAssignment[a._id.toString()] || 0;
    totalSubmitted += submitted;
    totalPending += Math.max(enrolled - submitted, 0);
  });

  // Salary summary — this teacher's own payslips only, never another staff member's.
  const received = payslips.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.netAmount, 0);
  const pending = payslips.filter((p) => p.status === 'pending').reduce((sum, p) => sum + p.netAmount, 0);
  const latest = payslips[0] || null;

  return ok(res, {
    todayClasses: todayClasses.map((c) => ({ id: c._id, subject: c.subject, classSection: c.classSection?.name || '', startTime: c.startTime, endTime: c.endTime, meetingLink: c.meetingLink })),
    todayAttendance: { total: totalMarked, present, absent },
    assignmentsOverview: { submitted: totalSubmitted, pending: totalPending, totalAssignments: assignments.length },
    upcomingExams: exams.map((e) => ({ id: e._id, title: e.title, type: e.type, courseTitle: e.course?.title || '', subject: e.course?.subject || '', scheduledDate: e.scheduledDate })),
    salary: {
      currency: latest?.currency || 'USD',
      monthly: latest?.netAmount || 0,
      total: received + pending,
      received,
      pending
    },
    notifications
  });
});

// GET /api/teachers/students/:studentId/timeline — one consolidated academic view of a student,
// scoped strictly to the courses THIS teacher actually teaches that student in (never another
// teacher's course, never the student's private personal goals from other institutions).
const getStudentTimeline = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const myCourseIds = await Course.find({ teacher: req.user._id }).distinct('_id');
  const enrollments = await Enrollment.find({ student: studentId, course: { $in: myCourseIds } }).populate('course', 'title subject');
  if (enrollments.length === 0) throw new AppError('This student is not enrolled in any course you teach.', 403);
  const courseIds = enrollments.map((e) => e.course._id);

  const student = await User.findById(studentId).select('fullName profilePhoto email');
  if (!student) throw new AppError('Student not found.', 404);

  const [results, submissions, attendanceRecords, certificates, completedGoals] = await Promise.all([
    Result.find({ student: studentId, course: { $in: courseIds } }).sort({ createdAt: -1 }),
    Submission.find({ student: studentId }).populate({ path: 'assignment', match: { course: { $in: courseIds } }, select: 'title course' }).sort({ createdAt: -1 }),
    Attendance.find({ course: { $in: courseIds }, 'records.student': studentId }).select('course date records'),
    Certificate.find({ student: studentId, course: { $in: courseIds } }).sort({ issueDate: -1 }),
    // Only goals the student has already chosen to make visible on their achievement timeline —
    // a teacher never sees a student's still-private/abandoned personal goals.
    StudentGoal.find({ student: studentId, status: 'completed' }).select('title category updatedAt')
  ]);

  const mySubmissions = submissions.filter((s) => s.assignment);

  let present = 0, total = 0;
  attendanceRecords.forEach((a) => a.records.forEach((r) => {
    if (r.student.toString() === studentId) { total += 1; if (r.status === 'present') present += 1; }
  }));

  const timeline = [
    ...results.map((r) => ({ type: 'Result', title: `${r.subject || r.term || 'Test'} — ${r.marksObtained}/${r.totalMarks}`, date: r.createdAt })),
    ...mySubmissions.map((s) => ({ type: s.status === 'graded' ? 'Assignment Graded' : 'Assignment Submitted', title: s.assignment.title, desc: s.marksObtained != null ? `${s.marksObtained} marks` : '', date: s.submittedAt })),
    ...certificates.map((c) => ({ type: 'Certificate Earned', title: c.title, date: c.issueDate })),
    ...completedGoals.map((g) => ({ type: 'Goal Achieved', title: g.title, date: g.updatedAt }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return ok(res, {
    student,
    courses: enrollments.map((e) => ({ course: e.course, progressPercent: e.progressPercent, overallScore: e.overallScore, completionStatus: e.completionStatus })),
    attendance: { present, total, percent: total > 0 ? Math.round((present / total) * 100) : null },
    timeline
  });
});

// GET /api/teachers/me/payout-status — refreshes payoutsEnabled/detailsSubmitted straight from
// Stripe (a teacher can finish/redo onboarding outside our app, e.g. re-verifying a bank account).
const getMyPayoutStatus = asyncHandler(async (req, res) => {
  const profile = await TeacherProfile.findOne({ user: req.user._id });
  if (!profile?.payout?.stripeAccountId) return ok(res, { connected: false, payoutsEnabled: false });
  if (isStripeConfigured()) {
    try {
      const account = await getStripeClient().accounts.retrieve(profile.payout.stripeAccountId);
      profile.payout.payoutsEnabled = Boolean(account.payouts_enabled);
      profile.payout.detailsSubmitted = Boolean(account.details_submitted);
      await profile.save();
    } catch { /* stale/local account id — surface whatever we have on file */ }
  }
  return ok(res, { connected: true, payoutsEnabled: profile.payout.payoutsEnabled, detailsSubmitted: profile.payout.detailsSubmitted });
});

// POST /api/teachers/me/payout-onboarding — creates (if needed) a Stripe Connect Express account
// for this teacher and returns a Stripe-hosted onboarding link. Bank details are entered directly
// on Stripe's own page and never touch our server.
const startPayoutOnboarding = asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) throw new AppError('Real bank transfer is not available — Stripe is not configured on this platform yet.', 503);
  const stripe = getStripeClient();
  let profile = await TeacherProfile.findOne({ user: req.user._id });
  if (!profile) profile = await TeacherProfile.create({ user: req.user._id });

  if (!profile.payout?.stripeAccountId) {
    const account = await stripe.accounts.create({ type: 'express', email: req.user.email, capabilities: { transfers: { requested: true } } });
    profile.payout = { stripeAccountId: account.id, payoutsEnabled: false, detailsSubmitted: false };
    await profile.save();
  }

  const base = env.clientUrl.split(',')[0].trim().replace(/\/+$/, '');
  const link = await stripe.accountLinks.create({
    account: profile.payout.stripeAccountId,
    refresh_url: `${base}/dashboard?payoutRefresh=1`,
    return_url: `${base}/dashboard?payoutComplete=1`,
    type: 'account_onboarding'
  });
  return ok(res, { url: link.url });
});

// GET /api/teachers/me/engagement-history — real, persisted Class Energy Meter + poll outcomes
// from this teacher's own past live classes (spec: "historical engagement analytics").
const getMyEngagementHistory = asyncHandler(async (req, res) => {
  const records = await ClassEngagementRecord.find({ teacher: req.user._id }).populate('course', 'title').sort({ createdAt: -1 }).limit(100);
  return ok(res, records);
});

module.exports = {
  getMyProfile, updateMyProfile, getMyClasses, markAttendance, markAttendanceByFace, listAttendance, getMyTimetable,
  createQrSession, getQrSession, setAttendanceLocation,
  listFaceCheckInRequests, reviewFaceCheckInRequest,
  checkInMyAttendance, getMySelfAttendance, getMyPayslips, verifyMyPayslipPayment, getMyDashboard,
  getStudentTimeline, getMyPayoutStatus, startPayoutOnboarding, getMyEngagementHistory
};
