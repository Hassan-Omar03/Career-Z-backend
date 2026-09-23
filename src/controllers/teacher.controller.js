const QRCode = require('qrcode');
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
const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { notifyParentsOfStudent } = require('../services/notification.service');

const DOW_BY_JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// GET /api/teachers/me
const getMyProfile = asyncHandler(async (req, res) => {
  let profile = await TeacherProfile.findOne({ user: req.user._id }).populate('institutions', 'name type country');
  if (!profile) profile = await TeacherProfile.create({ user: req.user._id });
  return ok(res, profile);
});

// PATCH /api/teachers/me
const updateMyProfile = asyncHandler(async (req, res) => {
  const allowed = ['subjects', 'qualifications', 'experienceYears', 'bio', 'independent'];
  const update = {};
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

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
  }

  const attendance = await Attendance.create({
    institution: institution || null,
    course: course || null,
    classSection: classSection || null,
    date,
    markedBy: req.user._id,
    records
  });

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
  return ok(res, { sessionId: session._id, qrDataUrl, expiresAt, checkedIn: 0 }, 'QR session started.');
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

  const student = await User.findById(studentId).select('fullName');
  if (!student) throw new AppError('Student not found.', 404);

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);

  let sheet = await Attendance.findOne({ course, date: { $gte: dayStart, $lte: dayEnd }, markedBy: req.user._id });
  if (!sheet) {
    sheet = await Attendance.create({ course, classSection: courseDoc.classSection, date, markedBy: req.user._id, records: [] });
  }

  const already = sheet.records.find((r) => r.student.toString() === studentId);
  if (already) {
    return ok(res, { studentName: student.fullName, alreadyMarked: true }, `${student.fullName} was already marked present today.`);
  }

  sheet.records.push({ student: studentId, status: 'present', method: 'face', checkedInAt: new Date() });
  await sheet.save();
  return ok(res, { studentName: student.fullName, alreadyMarked: false }, `${student.fullName} marked present.`);
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

module.exports = {
  getMyProfile, updateMyProfile, getMyClasses, markAttendance, markAttendanceByFace, listAttendance, getMyTimetable,
  createQrSession, getQrSession, setAttendanceLocation,
  checkInMyAttendance, getMySelfAttendance, getMyPayslips, getMyDashboard
};
