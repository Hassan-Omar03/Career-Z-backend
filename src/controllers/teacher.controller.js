const TeacherProfile = require('../models/TeacherProfile');
const Course = require('../models/Course');
const Attendance = require('../models/Attendance');
const TimetableEntry = require('../models/TimetableEntry');
const Payslip = require('../models/Payslip');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Enrollment = require('../models/Enrollment');
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
  if (!date || !Array.isArray(records) || records.length === 0) {
    throw new AppError('date and a non-empty records array are required.', 422);
  }

  // If tied to a course, verify ownership.
  if (course) {
    const courseDoc = await Course.findById(course);
    if (!courseDoc) throw new AppError('Course not found.', 404);
    if (courseDoc.teacher.toString() !== req.user._id.toString()) {
      throw new AppError('You do not teach this course.', 403);
    }
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

module.exports = { getMyProfile, updateMyProfile, getMyClasses, markAttendance, listAttendance, getMyTimetable, getMyPayslips, getMyDashboard };
