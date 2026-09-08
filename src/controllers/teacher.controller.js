const TeacherProfile = require('../models/TeacherProfile');
const Course = require('../models/Course');
const Attendance = require('../models/Attendance');
const TimetableEntry = require('../models/TimetableEntry');
const Payslip = require('../models/Payslip');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

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

module.exports = { getMyProfile, updateMyProfile, getMyClasses, markAttendance, listAttendance, getMyTimetable, getMyPayslips };
