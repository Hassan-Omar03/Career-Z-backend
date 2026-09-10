const StudentProfile = require('../models/StudentProfile');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const Result = require('../models/Result');
const Submission = require('../models/Submission');
const Assignment = require('../models/Assignment');
const Fee = require('../models/Fee');
const TimetableEntry = require('../models/TimetableEntry');
const JobApplication = require('../models/JobApplication');
const ScholarshipApplication = require('../models/ScholarshipApplication');
const Scholarship = require('../models/Scholarship');
const Order = require('../models/Order');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Course = require('../models/Course');
const Exam = require('../models/Exam');
const ExamSubmission = require('../models/ExamSubmission');
const Certificate = require('../models/Certificate');
const Sponsorship = require('../models/Sponsorship');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notifyMany } = require('../services/notification.service');

// Any donor sponsoring this student hears about real profile/institution changes —
// Donor Notifications item "Recipient progress update".
async function notifySponsorsOfProgress(studentId, studentName) {
  const donorIds = await Sponsorship.find({ student: studentId, status: { $ne: 'cancelled' } }).distinct('donor');
  if (donorIds.length > 0) {
    await notifyMany(donorIds, { title: `Recipient progress update: ${studentName} updated their profile` }).catch(() => {});
  }
}

// GET /api/students/me
const getMyProfile = asyncHandler(async (req, res) => {
  let profile = await StudentProfile.findOne({ user: req.user._id })
    .populate('primaryInstitution', 'name type country')
    .populate('classSection', 'name academicYear');

  if (!profile) {
    profile = await StudentProfile.create({ user: req.user._id });
  }
  return ok(res, profile);
});

// PATCH /api/students/me
const updateMyProfile = asyncHandler(async (req, res) => {
  const allowed = ['dateOfBirth', 'guardianContact', 'skills', 'languages', 'careerGoal', 'program', 'currentTerm'];
  const update = {};
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

  const profile = await StudentProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
  await notifySponsorsOfProgress(req.user._id, req.user.fullName);
  return ok(res, profile);
});

// POST /api/students/me/connect-institution
const connectToInstitution = asyncHandler(async (req, res) => {
  const { institutionId, classSectionId, rollNumber } = req.body;
  if (!institutionId) throw new AppError('institutionId is required.', 422);

  const profile = await StudentProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: {
        primaryInstitution: institutionId,
        classSection: classSectionId || null,
        rollNumber: rollNumber || '',
        admissionDate: new Date()
      }
    },
    { new: true, upsert: true, runValidators: true }
  );

  await notifySponsorsOfProgress(req.user._id, req.user.fullName);
  return ok(res, profile, 'Connected to institution.');
});

// GET /api/students/me/attendance
const getMyAttendance = asyncHandler(async (req, res) => {
  const records = await Attendance.find({ 'records.student': req.user._id })
    .sort({ date: -1 })
    .select('date institution course classSection records.$');
  return ok(res, records);
});

// GET /api/students/me/results
const getMyResults = asyncHandler(async (req, res) => {
  const results = await Result.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, results);
});

// GET /api/students/me/enrollments
const getMyEnrollments = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ student: req.user._id }).populate('course', 'title subject teacher published');
  return ok(res, enrollments);
});

// GET /api/students/me/submissions
const getMySubmissions = asyncHandler(async (req, res) => {
  const submissions = await Submission.find({ student: req.user._id }).populate('assignment', 'title dueDate maxMarks');
  return ok(res, submissions);
});

// GET /api/students/me/fees
const getMyFees = asyncHandler(async (req, res) => {
  const fees = await Fee.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, fees);
});

// GET /api/students/me/timetable
const getMyTimetable = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile || !profile.classSection) return ok(res, []);

  const entries = await TimetableEntry.find({ classSection: profile.classSection })
    .populate('teacher', 'fullName')
    .sort({ dayOfWeek: 1, startTime: 1 });
  return ok(res, entries);
});

const DOW_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// GET /api/students/me/dashboard — everything the Student home page summary needs, in one
// call, aggregated from real records (enrollments, timetable, assignments, fees, applications,
// scholarships, saved jobs). No field here is hardcoded or fabricated.
const getMyDashboard = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const profile = await StudentProfile.findOne({ user: userId })
    .populate('primaryInstitution', 'name type country')
    .populate('classSection', 'name academicYear');

  // Independent of any institution connection — a student can enroll in courses without one.
  const courseIds = await Enrollment.find({ student: userId }).distinct('course');

  const [
    enrollments, timetable, submissions, assignments, results, attendanceRecords,
    fees, jobApps, savedJobsUser, scholarshipApps, openScholarships, marketplaceOrders,
    courseLessons, courseSubjects, exams, examSubmissions, certificates
  ] = await Promise.all([
    Enrollment.find({ student: userId }).populate('course', 'title subject teacher'),
    profile?.classSection ? TimetableEntry.find({ classSection: profile.classSection }).populate('teacher', 'fullName') : [],
    Submission.find({ student: userId }).populate('assignment', 'title dueDate maxMarks course'),
    Assignment.find({ course: { $in: courseIds } }),
    Result.find({ student: userId }).sort({ createdAt: -1 }).limit(10),
    Attendance.find({ 'records.student': userId }).sort({ date: -1 }).limit(60),
    Fee.find({ student: userId }),
    JobApplication.find({ applicant: userId }).populate('job', 'title company'),
    User.findById(userId).select('savedJobs').populate('savedJobs', 'title company'),
    ScholarshipApplication.find({ applicant: userId }).populate('scholarship', 'title amount currency'),
    Scholarship.find({ status: 'open' }).limit(5),
    Order.find({ buyer: userId }).populate('product', 'title'),
    Lesson.find({ course: { $in: courseIds } }).sort({ order: 1 }).select('course title order'),
    Course.find({ _id: { $in: courseIds } }).select('subject'),
    Exam.find({ course: { $in: courseIds }, published: true }).select('title course'),
    ExamSubmission.find({ student: userId }).select('exam'),
    Certificate.find({ student: userId }).sort({ issueDate: -1 }).limit(5)
  ]);

  // Current / upcoming classes from the weekly (recurring) timetable.
  const now = new Date();
  const todayKey = DOW_ORDER[now.getDay()];
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (t) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };

  const todays = timetable.filter((t) => t.dayOfWeek === todayKey);
  const currentClasses = todays.filter((t) => toMinutes(t.startTime) <= nowMinutes && nowMinutes <= toMinutes(t.endTime));
  const todayIndex = DOW_ORDER.indexOf(todayKey);
  const circularDaysAway = (dow) => (DOW_ORDER.indexOf(dow) - todayIndex + 7) % 7;
  const laterToday = todays.filter((t) => toMinutes(t.startTime) > nowMinutes).sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const otherDays = timetable.filter((t) => t.dayOfWeek !== todayKey)
    .sort((a, b) => circularDaysAway(a.dayOfWeek) - circularDaysAway(b.dayOfWeek) || toMinutes(a.startTime) - toMinutes(b.startTime));
  const upcomingClasses = [...laterToday, ...otherDays].slice(0, 5);

  // Pending assignments = assignments in enrolled courses with no submission yet.
  const submittedAssignmentIds = new Set(submissions.map((s) => s.assignment?._id?.toString()).filter(Boolean));
  const pendingAssignments = assignments.filter((a) => !submittedAssignmentIds.has(a._id.toString()));

  // Pending exams/quizzes = published exams in enrolled courses with no submission yet.
  const submittedExamIds = new Set(examSubmissions.map((s) => s.exam?.toString()).filter(Boolean));
  const pendingExams = exams.filter((e) => !submittedExamIds.has(e._id.toString()));

  // Academic progress.
  let present = 0, totalMarks = 0;
  attendanceRecords.forEach((r) => r.records.forEach((rec) => {
    if (rec.student.toString() === userId.toString()) { totalMarks += 1; if (rec.status === 'present') present += 1; }
  }));
  const attendanceRate = totalMarks > 0 ? Math.round((present / totalMarks) * 100) : null;
  const avgCourseProgress = enrollments.length > 0
    ? Math.round(enrollments.reduce((sum, e) => sum + (e.progressPercent || 0), 0) / enrollments.length)
    : 0;
  const lessonsByCourse = {};
  courseLessons.forEach((l) => {
    const key = l.course.toString();
    (lessonsByCourse[key] = lessonsByCourse[key] || []).push(l);
  });
  const totalLessons = enrollments.reduce((sum, e) => sum + (lessonsByCourse[e.course?._id?.toString()]?.length || 0), 0);
  const completedLessons = enrollments.reduce((sum, e) => sum + (e.completedLessons?.length || 0), 0);
  const subjects = Array.from(new Set(courseSubjects.map((c) => c.subject).filter(Boolean)));
  const latestGrades = results.slice(0, 5).map((r) => ({ subject: r.subject, marksObtained: r.marksObtained, totalMarks: r.totalMarks, grade: r.grade }));

  // Course Progress Overview — current (next uncompleted) lesson + completed/remaining per course.
  const courseProgressDetail = enrollments.map((e) => {
    const lessons = lessonsByCourse[e.course?._id?.toString()] || [];
    const completedIds = new Set((e.completedLessons || []).map(String));
    const nextLesson = lessons.find((l) => !completedIds.has(l._id.toString()));
    return {
      id: e._id,
      course: e.course,
      progressPercent: e.progressPercent,
      currentLesson: nextLesson ? nextLesson.title : null,
      completedLessons: lessons.filter((l) => completedIds.has(l._id.toString())).length,
      remainingLessons: lessons.length - lessons.filter((l) => completedIds.has(l._id.toString())).length,
      totalLessons: lessons.length
    };
  });

  // Wallet: pending fee total + a light transaction list (paid fees + marketplace purchases).
  const pendingFees = fees.filter((f) => f.status !== 'paid');
  const pendingFeeTotal = pendingFees.reduce((sum, f) => sum + f.amount, 0);
  const recentTransactions = [
    ...fees.filter((f) => f.status === 'paid').map((f) => ({ label: `Fee: ${f.title}`, amount: -f.amount, currency: f.currency, date: f.paidAt || f.updatedAt })),
    ...marketplaceOrders.map((o) => ({ label: `Marketplace: ${o.product?.title || 'Order'}`, amount: -o.totalPrice, currency: o.currency, date: o.createdAt }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

  const appliedScholarshipIds = new Set(scholarshipApps.map((a) => a.scholarship?._id?.toString()).filter(Boolean));
  const recommendedScholarships = openScholarships.filter((s) => !appliedScholarshipIds.has(s._id.toString())).slice(0, 3);

  const activeApplications = jobApps.filter((a) => ['pending', 'viewed', 'shortlisted', 'interview', 'selected'].includes(a.status)).length
    + scholarshipApps.filter((a) => a.status === 'pending').length;

  // Recent Activity — every kind the spec asks for (course, application, payment, marketplace),
  // not just role-request/enrollment events.
  const recentActivity = [
    ...enrollments.map((e) => ({ id: `enr-${e._id}`, title: `Enrolled in "${e.course?.title || 'a course'}"`, desc: e.course?.subject || '', time: e.updatedAt, status: e.status })),
    ...jobApps.map((a) => ({ id: `job-${a._id}`, title: `Applied to "${a.job?.title || 'a job'}"`, desc: a.job?.company || '', time: a.createdAt, status: a.status })),
    ...scholarshipApps.map((a) => ({ id: `sch-${a._id}`, title: `Applied to scholarship "${a.scholarship?.title || ''}"`, desc: '', time: a.createdAt, status: a.status })),
    ...fees.filter((f) => f.status === 'paid').map((f) => ({ id: `fee-${f._id}`, title: `Paid fee: ${f.title}`, desc: `${f.currency} ${f.amount}`, time: f.paidAt || f.updatedAt, status: 'approved' })),
    ...marketplaceOrders.map((o) => ({ id: `ord-${o._id}`, title: `Ordered "${o.product?.title || 'an item'}"`, desc: `${o.currency} ${o.totalPrice}`, time: o.createdAt, status: o.status })),
    ...certificates.map((c) => ({ id: `cert-${c._id}`, title: `Certificate received: ${c.title}`, desc: '', time: c.issueDate, status: 'approved' }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

  // Application status across every applicable type — for the dashboard's Applications Overview
  // preview (the full breakdown/history lives on the Applications page).
  const applicationsOverview = [
    ...jobApps.map((a) => ({ type: 'Job', title: a.job?.title, status: a.status, time: a.createdAt })),
    ...scholarshipApps.map((a) => ({ type: 'Scholarship', title: a.scholarship?.title, status: a.status, time: a.createdAt })),
    ...(profile?.primaryInstitution ? [{ type: 'Institution', title: profile.primaryInstitution.name, status: 'approved', time: profile.admissionDate || profile.createdAt }] : []),
    ...enrollments.map((e) => ({ type: 'Course', title: e.course?.title, status: e.status === 'completed' ? 'approved' : e.status === 'dropped' ? 'rejected' : 'approved', time: e.enrolledAt }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 6);

  return ok(res, {
    welcome: {
      institution: profile?.primaryInstitution || null,
      classSection: profile?.classSection || null,
      program: profile?.program || '',
      currentTerm: profile?.currentTerm || ''
    },
    activeApplications,
    enrollments: enrollments.map((e) => ({ id: e._id, course: e.course, status: e.status, progressPercent: e.progressPercent })),
    courseProgressDetail,
    currentClasses,
    upcomingClasses,
    pendingAssignments: pendingAssignments.map((a) => ({ id: a._id, title: a.title, dueDate: a.dueDate, maxMarks: a.maxMarks })),
    pendingExams: pendingExams.map((e) => ({ id: e._id, title: e.title })),
    recentResults: results,
    latestGrades,
    academicProgress: {
      attendanceRate, avgCourseProgress, subjects,
      completedLessons, totalLessons,
      completedCourses: enrollments.filter((e) => e.status === 'completed').length, totalCourses: enrollments.length
    },
    scholarships: { recommended: recommendedScholarships, applied: scholarshipApps },
    savedJobs: savedJobsUser?.savedJobs || [],
    wallet: { availableBalance: 0, pendingFeeTotal, pendingFeeCount: pendingFees.length, recentTransactions, pendingFees },
    applicationsOverview,
    recentActivity
  });
});

module.exports = {
  getMyProfile,
  updateMyProfile,
  connectToInstitution,
  getMyAttendance,
  getMyResults,
  getMyEnrollments,
  getMySubmissions,
  getMyFees,
  getMyTimetable,
  getMyDashboard
};
