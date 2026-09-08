const StudentProfile = require('../models/StudentProfile');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const Result = require('../models/Result');
const Submission = require('../models/Submission');
const Fee = require('../models/Fee');
const TimetableEntry = require('../models/TimetableEntry');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

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
  const allowed = ['dateOfBirth', 'guardianContact', 'skills', 'languages', 'careerGoal'];
  const update = {};
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

  const profile = await StudentProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );
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

module.exports = {
  getMyProfile,
  updateMyProfile,
  connectToInstitution,
  getMyAttendance,
  getMyResults,
  getMyEnrollments,
  getMySubmissions,
  getMyFees,
  getMyTimetable
};
