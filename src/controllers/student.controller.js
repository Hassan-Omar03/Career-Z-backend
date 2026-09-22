const QRCode = require('qrcode');
const crypto = require('crypto');
const env = require('../config/env');
const StudentProfile = require('../models/StudentProfile');
const StudentDocument = require('../models/StudentDocument');
const StudentGoal = require('../models/StudentGoal');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const AttendanceSession = require('../models/AttendanceSession');
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
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyMany } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');
const { computeReceiptAmounts } = require('../utils/receiptCalc');

const PAYMENT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', card: 'Card', mobile_wallet: 'Mobile Wallet', cash: 'Cash', other: 'Other'
};
const FEE_COMMISSION_KEY = 'fee_commission_percent';

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
  const allowed = ['dateOfBirth', 'guardianContact', 'emergencyContact', 'skills', 'languages', 'interests', 'hobbies', 'careerGoal', 'program', 'currentTerm'];
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

// POST /api/students/me/attendance/qr-checkin — student scans the teacher's session QR (decoded
// locally by the browser) and self-checks-in. The token is single-session and time-limited, so
// an old/screenshotted QR stops working once the session's `expiresAt` passes.
const qrCheckIn = asyncHandler(async (req, res) => {
  const { token, date } = req.body;
  if (!token || !date) throw new AppError('token and date are required.', 422);

  const session = await AttendanceSession.findOne({ token });
  if (!session) throw new AppError('This QR code is invalid.', 404);
  if (session.expiresAt < new Date()) throw new AppError('This QR code has expired — ask your teacher for a new one.', 410);

  const courseDoc = await Course.findById(session.course);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  const enrolled = await Enrollment.findOne({ course: session.course, student: req.user._id });
  if (!enrolled) throw new AppError('You are not enrolled in this course.', 400);

  if (session.checkedIn.some((id) => id.toString() === req.user._id.toString())) {
    return ok(res, { alreadyMarked: true }, 'You already checked in for this session.');
  }
  session.checkedIn.push(req.user._id);
  await session.save();

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  let sheet = await Attendance.findOne({ course: session.course, date: { $gte: dayStart, $lte: dayEnd } });
  if (!sheet) {
    sheet = await Attendance.create({ course: session.course, classSection: courseDoc.classSection, date, markedBy: courseDoc.teacher, records: [] });
  }
  const already = sheet.records.find((r) => r.student.toString() === req.user._id.toString());
  if (!already) {
    sheet.records.push({ student: req.user._id, status: 'present', method: 'qr' });
    await sheet.save();
  }

  return ok(res, { alreadyMarked: false }, 'Attendance marked via QR check-in.');
});

// Haversine formula — great-circle distance between two lat/lng points, in meters.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// POST /api/students/me/attendance/gps-checkin — optional GPS attendance (spec: optional, since
// it needs browser/device location permission). Only accepted if the course has GPS attendance
// enabled and the student's submitted coordinates fall inside its configured radius.
const gpsCheckIn = asyncHandler(async (req, res) => {
  const { course: courseId, date, lat, lng } = req.body;
  if (!courseId || !date || lat === undefined || lng === undefined) {
    throw new AppError('course, date, lat and lng are required.', 422);
  }

  const courseDoc = await Course.findById(courseId);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  if (!courseDoc.attendanceLocation?.enabled) throw new AppError('GPS attendance is not enabled for this course.', 400);

  const enrolled = await Enrollment.findOne({ course: courseId, student: req.user._id });
  if (!enrolled) throw new AppError('You are not enrolled in this course.', 400);

  const { lat: allowedLat, lng: allowedLng, radiusMeters } = courseDoc.attendanceLocation;
  const distance = distanceMeters(Number(lat), Number(lng), allowedLat, allowedLng);
  if (distance > radiusMeters) {
    throw new AppError(`You're too far from the class location (${Math.round(distance)}m away, ${radiusMeters}m allowed).`, 422);
  }

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  let sheet = await Attendance.findOne({ course: courseId, date: { $gte: dayStart, $lte: dayEnd } });
  if (!sheet) {
    sheet = await Attendance.create({ course: courseId, classSection: courseDoc.classSection, date, markedBy: courseDoc.teacher, records: [] });
  }
  const already = sheet.records.find((r) => r.student.toString() === req.user._id.toString());
  if (already) return ok(res, { alreadyMarked: true, distanceMeters: Math.round(distance) }, 'You were already marked present today.');

  sheet.records.push({ student: req.user._id, status: 'present', method: 'gps', location: { lat, lng, distanceMeters: Math.round(distance) } });
  await sheet.save();

  return ok(res, { alreadyMarked: false, distanceMeters: Math.round(distance) }, 'Attendance marked via GPS check-in.');
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

// PATCH /api/students/me/fees/:feeId/pay — report a manual payment for institution verification.
// Card payments must use the gateway checkout; this endpoint never issues a receipt.
const payMyFee = asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  if (!paymentMethod || !PAYMENT_METHOD_LABEL[paymentMethod]) {
    throw new AppError('A valid paymentMethod is required (bank_transfer, card, mobile_wallet, cash or other).', 422);
  }

  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.student.toString() !== req.user._id.toString()) throw new AppError('This is not your fee.', 403);
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

// ---------------------------------------------------------------- Digital Locker (Part 10.5)

// GET /api/students/me/documents
const listMyDocuments = asyncHandler(async (req, res) => {
  const documents = await StudentDocument.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, documents);
});

// POST /api/students/me/documents
const addMyDocument = asyncHandler(async (req, res) => {
  const { title, category, fileUrl, status, pendingReason } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  if (status !== 'pending' && !fileUrl) throw new AppError('fileUrl is required unless you mark this as pending.', 422);

  const doc = await StudentDocument.create({
    student: req.user._id,
    title,
    category: category || 'other',
    fileUrl: status === 'pending' ? '' : fileUrl,
    status: status === 'pending' ? 'pending' : 'available',
    pendingReason: status === 'pending' ? (pendingReason || '') : ''
  });
  return created(res, doc, status === 'pending' ? 'Saved as pending — add the file whenever you have it.' : 'Document added to your locker.');
});

// PATCH /api/students/me/documents/:id — attach the real file to a document that was earlier
// saved as "pending" (or just update its title/category).
const updateMyDocument = asyncHandler(async (req, res) => {
  const doc = await StudentDocument.findOne({ _id: req.params.id, student: req.user._id });
  if (!doc) throw new AppError('Document not found.', 404);

  const { title, category, fileUrl } = req.body;
  if (title !== undefined) doc.title = title;
  if (category !== undefined) doc.category = category;
  if (fileUrl) {
    doc.fileUrl = fileUrl;
    doc.status = 'available';
    doc.pendingReason = '';
  }
  await doc.save();
  return ok(res, doc, 'Document updated.');
});

// DELETE /api/students/me/documents/:id
const removeMyDocument = asyncHandler(async (req, res) => {
  const doc = await StudentDocument.findOne({ _id: req.params.id, student: req.user._id });
  if (!doc) throw new AppError('Document not found.', 404);
  await doc.deleteOne();
  return ok(res, null, 'Document removed.');
});

// ---------------------------------------------------------- Digital Student ID (Part 10.18)

// GET /api/students/me/student-id — a QR-verifiable ID card, same trust pattern as Certificate
// (a stable random code + public verify endpoint), built from real enrollment data.
const getMyStudentId = asyncHandler(async (req, res) => {
  let profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) profile = await StudentProfile.create({ user: req.user._id });

  // Profiles created before this field existed won't have it in the database — the schema
  // `default` only applies to brand-new documents, not to hydrating an existing one, so a plain
  // in-memory `if (!profile.idCardCode)` check here would generate a code that's never actually
  // persisted (and would 404 on verify). Check the raw stored document instead.
  const raw = await StudentProfile.findById(profile._id).lean();
  if (!raw.idCardCode) {
    const code = crypto.randomBytes(8).toString('hex');
    await StudentProfile.updateOne({ _id: profile._id }, { $set: { idCardCode: code } });
    profile.idCardCode = code;
  }

  await profile.populate('primaryInstitution', 'name');
  await profile.populate('classSection', 'name academicYear');

  const verifyUrl = `${env.clientUrl}/verify-student-id/${profile.idCardCode}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);

  return ok(res, {
    fullName: req.user.fullName,
    profilePhoto: req.user.profilePhoto,
    rollNumber: profile.rollNumber,
    institution: profile.primaryInstitution,
    classSection: profile.classSection,
    status: profile.status,
    verifyUrl,
    qrDataUrl
  });
});

// GET /api/students/verify-id/:code (public) — anyone can scan the QR and confirm this is a
// real enrolled student, without seeing anything private.
const verifyStudentId = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ idCardCode: req.params.code })
    .populate('user', 'fullName profilePhoto')
    .populate('primaryInstitution', 'name')
    .populate('classSection', 'name');
  if (!profile) throw new AppError('Student ID not found. It may be invalid.', 404);

  return ok(res, {
    fullName: profile.user.fullName,
    profilePhoto: profile.user.profilePhoto,
    rollNumber: profile.rollNumber,
    institutionName: profile.primaryInstitution?.name || null,
    classSectionName: profile.classSection?.name || null,
    status: profile.status
  });
});

// PUT /api/students/me/face-descriptor — the student's own browser computes this (128 numbers,
// via face-api.js) from their profile photo and uploads it once. No image is stored, no face
// recognition runs on this server — only these numbers, used later by a teacher's browser to
// compare against a live camera frame.
const saveMyFaceDescriptor = asyncHandler(async (req, res) => {
  const { descriptor } = req.body;
  if (!Array.isArray(descriptor) || descriptor.length !== 128 || descriptor.some((n) => typeof n !== 'number')) {
    throw new AppError('descriptor must be an array of 128 numbers.', 422);
  }
  await StudentProfile.findOneAndUpdate({ user: req.user._id }, { $set: { faceDescriptor: descriptor } }, { upsert: true });
  return ok(res, null, 'Face enrolled for attendance.');
});

// -------------------------------------------------------------- Learning Analytics (Part 10.12)

// GET /api/students/me/learning-analytics — real per-subject averages computed from actual
// Result documents, and a weekly attendance trend from actual Attendance records. No AI call,
// no fabricated numbers — just arithmetic over the student's own real records.
const getMyLearningAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [results, attendanceRecords] = await Promise.all([
    Result.find({ student: userId }).sort({ createdAt: 1 }),
    Attendance.find({ 'records.student': userId }).sort({ date: 1 })
  ]);

  const bySubject = {};
  results.forEach((r) => {
    const key = r.subject || 'General';
    if (!bySubject[key]) bySubject[key] = { subject: key, totalObtained: 0, totalMax: 0, count: 0 };
    bySubject[key].totalObtained += r.marksObtained || 0;
    bySubject[key].totalMax += r.totalMarks || 0;
    bySubject[key].count += 1;
  });
  const subjectPerformance = Object.values(bySubject).map((s) => ({
    subject: s.subject,
    averagePercent: s.totalMax > 0 ? Math.round((s.totalObtained / s.totalMax) * 100) : null,
    testsCount: s.count
  })).sort((a, b) => (a.averagePercent ?? 100) - (b.averagePercent ?? 100));

  const weakestSubjects = subjectPerformance.filter((s) => s.averagePercent !== null).slice(0, 3);
  const strongestSubjects = [...subjectPerformance].filter((s) => s.averagePercent !== null).reverse().slice(0, 3);

  // Weekly attendance trend — group present/absent by ISO week.
  const weekKey = (d) => {
    const date = new Date(d);
    const jan1 = new Date(date.getFullYear(), 0, 1);
    const week = Math.ceil(((date - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${date.getFullYear()}-W${week}`;
  };
  const byWeek = {};
  attendanceRecords.forEach((r) => {
    const rec = r.records.find((x) => x.student.toString() === userId.toString());
    if (!rec) return;
    const key = weekKey(r.date);
    if (!byWeek[key]) byWeek[key] = { week: key, present: 0, total: 0 };
    byWeek[key].total += 1;
    if (rec.status === 'present') byWeek[key].present += 1;
  });
  const attendanceTrend = Object.values(byWeek).map((w) => ({ week: w.week, ratePercent: Math.round((w.present / w.total) * 100) }));

  const overallAverage = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + (r.totalMarks > 0 ? (r.marksObtained / r.totalMarks) * 100 : 0), 0) / results.length)
    : null;

  return ok(res, {
    subjectPerformance,
    weakestSubjects,
    strongestSubjects,
    attendanceTrend,
    overallAverage,
    examReadiness: overallAverage !== null ? (overallAverage >= 75 ? 'Strong' : overallAverage >= 50 ? 'Needs Practice' : 'At Risk') : null
  });
});

// -------------------------------------------------------------------- Goal Tracking (Part 10.22)
// No AI here — the student sets their own goal and self-reports progress. AI-generated goal
// suggestions are a separate, later phase that needs the student's own AI API key.

// GET /api/students/me/goals
const listMyGoals = asyncHandler(async (req, res) => {
  const goals = await StudentGoal.find({ student: req.user._id }).sort({ createdAt: -1 });
  return ok(res, goals);
});

// POST /api/students/me/goals
const addMyGoal = asyncHandler(async (req, res) => {
  const { title, category, targetDate, notes } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  const goal = await StudentGoal.create({ student: req.user._id, title, category: category || 'other', targetDate: targetDate || null, notes: notes || '' });
  return created(res, goal, 'Goal added.');
});

// PATCH /api/students/me/goals/:id
const updateMyGoal = asyncHandler(async (req, res) => {
  const goal = await StudentGoal.findOne({ _id: req.params.id, student: req.user._id });
  if (!goal) throw new AppError('Goal not found.', 404);
  const allowed = ['title', 'category', 'targetDate', 'progressPercent', 'status', 'notes'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) goal[f] = req.body[f]; });
  await goal.save();
  return ok(res, goal);
});

// DELETE /api/students/me/goals/:id
const removeMyGoal = asyncHandler(async (req, res) => {
  const goal = await StudentGoal.findOne({ _id: req.params.id, student: req.user._id });
  if (!goal) throw new AppError('Goal not found.', 404);
  await goal.deleteOne();
  return ok(res, null, 'Goal removed.');
});

// ---------------------------------------------------------- Achievement Timeline (Part 10.23)
// Every real milestone (completed courses, certificates earned, high test scores, scholarships
// won, jobs landed, goals achieved) in one chronological feed. Unlike the dashboard's
// recentActivity (last 10, mixes pending items), this is the full lifetime achievement history —
// only things that actually happened (approved/completed/won), never pending or fabricated.
const getMyAchievementTimeline = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [enrollments, certificates, results, scholarshipApps, jobApps, goals] = await Promise.all([
    Enrollment.find({ student: userId, status: 'completed' }).populate('course', 'title subject'),
    Certificate.find({ student: userId }).populate('institution', 'name'),
    Result.find({ student: userId }),
    ScholarshipApplication.find({ applicant: userId, status: 'approved' }).populate('scholarship', 'title'),
    JobApplication.find({ applicant: userId, status: 'hired' }).populate('job', 'title company'),
    StudentGoal.find({ student: userId, status: 'completed' })
  ]);

  const highScores = results.filter((r) => r.totalMarks > 0 && (r.marksObtained / r.totalMarks) >= 0.9);

  const timeline = [
    ...enrollments.map((e) => ({ type: 'Course Completed', title: e.course?.title || 'A course', date: e.completedAt || e.updatedAt })),
    ...certificates.map((c) => ({ type: 'Certificate Earned', title: c.title, desc: c.institution?.name, date: c.issueDate })),
    ...highScores.map((r) => ({ type: 'High Score', title: `${r.subject || r.term || 'Test'} — ${r.marksObtained}/${r.totalMarks}`, date: r.createdAt })),
    ...scholarshipApps.map((a) => ({ type: 'Scholarship Won', title: a.scholarship?.title || 'Scholarship', date: a.updatedAt })),
    ...jobApps.map((a) => ({ type: 'Job Offer Accepted', title: `${a.job?.title || 'Job'}${a.job?.company ? ` at ${a.job.company}` : ''}`, date: a.updatedAt })),
    ...goals.map((g) => ({ type: 'Goal Achieved', title: g.title, date: g.updatedAt }))
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  return ok(res, timeline);
});

// ------------------------------------------------------------- Reputation / Badges (Part 10.19)
// Every badge is a rule computed over the student's own real records — nothing here is assigned
// manually or fabricated. A badge only appears once its underlying condition is actually true.
const getMyBadges = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [enrollments, certificates, results, attendanceRecords, goals, completedGoals] = await Promise.all([
    Enrollment.find({ student: userId }),
    Certificate.countDocuments({ student: userId }),
    Result.find({ student: userId }),
    Attendance.find({ 'records.student': userId }),
    StudentGoal.countDocuments({ student: userId }),
    StudentGoal.countDocuments({ student: userId, status: 'completed' })
  ]);

  let present = 0, total = 0;
  attendanceRecords.forEach((r) => r.records.forEach((rec) => {
    if (rec.student.toString() === userId.toString()) { total += 1; if (rec.status === 'present') present += 1; }
  }));
  const attendanceRate = total > 0 ? Math.round((present / total) * 100) : null;

  const highScoreCount = results.filter((r) => r.totalMarks > 0 && (r.marksObtained / r.totalMarks) >= 0.9).length;
  const completedCourses = enrollments.filter((e) => e.status === 'completed').length;

  const badges = [
    { code: 'active_learner', label: 'Active Learner', desc: 'Enrolled in 3 or more courses', earned: enrollments.length >= 3 },
    { code: 'course_completer', label: 'Course Completer', desc: 'Completed at least one course', earned: completedCourses >= 1 },
    { code: 'perfect_attendance', label: 'Perfect Attendance', desc: '100% attendance record', earned: attendanceRate === 100 },
    { code: 'high_achiever', label: 'High Achiever', desc: 'Scored 90% or higher on a test', earned: highScoreCount >= 1 },
    { code: 'certified', label: 'Certified', desc: 'Earned at least one certificate', earned: certificates >= 1 },
    { code: 'goal_setter', label: 'Goal Setter', desc: 'Set at least one personal goal', earned: goals >= 1 },
    { code: 'goal_achiever', label: 'Goal Achiever', desc: 'Completed at least one personal goal', earned: completedGoals >= 1 }
  ];

  return ok(res, { badges, earnedCount: badges.filter((b) => b.earned).length, totalCount: badges.length });
});

module.exports = {
  getMyProfile,
  updateMyProfile,
  connectToInstitution,
  qrCheckIn,
  gpsCheckIn,
  getMyAttendance,
  getMyResults,
  getMyEnrollments,
  getMySubmissions,
  getMyFees,
  payMyFee,
  getMyTimetable,
  getMyDashboard,
  listMyDocuments,
  addMyDocument,
  updateMyDocument,
  removeMyDocument,
  getMyStudentId,
  verifyStudentId,
  saveMyFaceDescriptor,
  getMyLearningAnalytics,
  listMyGoals,
  addMyGoal,
  updateMyGoal,
  removeMyGoal,
  getMyAchievementTimeline,
  getMyBadges
};
