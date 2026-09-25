const crypto = require('crypto');
const LiveClassSession = require('../models/LiveClassSession');
const Institution = require('../models/Institution');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notifyMany } = require('../services/notification.service');
const { assertInstitutionFeeAccess } = require('../utils/feeAccess');
const { emitToLiveVideoRoom } = require('../realtime/socket');

function assertInstitutionManager(institution, userId) {
  if (!institution) throw new AppError('Institution not found.', 404);
  const manages = String(institution.owner) === String(userId)
    || institution.staff.some((member) => String(member.user) === String(userId));
  if (!manages) throw new AppError('You do not manage this institution.', 403);
}

function populated(query) {
  return query
    .populate('institution', 'name')
    .populate('course', 'title subject')
    .populate('classSection', 'name academicYear')
    .populate('teacher', 'fullName email');
}

async function notifyCourseStudents(courseId, payload, sentBy) {
  const enrollments = await Enrollment.find({ course: courseId, status: { $ne: 'dropped' } }).select('student');
  if (enrollments.length) await notifyMany(enrollments.map((row) => row.student), { ...payload, sentBy });
}

const schedule = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.body.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  const course = await Course.findOne({ _id: req.body.course, institution: institution._id });
  if (!course) throw new AppError('Select a course belonging to this institution.', 422);
  const isAssignedTeacher = String(course.teacher) === String(req.user._id);
  if (!isAssignedTeacher) throw new AppError('Only the teacher assigned to this course can schedule its live class.', 403);
  if (!course.classSection) throw new AppError('Assign this course to a class section first.', 422);
  const teacherId = course.teacher;
  const scheduledStart = new Date(req.body.scheduledStart);
  const scheduledEnd = new Date(req.body.scheduledEnd);
  if (!Number.isFinite(scheduledStart.getTime()) || !Number.isFinite(scheduledEnd.getTime()) || scheduledEnd <= scheduledStart) {
    throw new AppError('Choose a valid start and end time.', 422);
  }
  const provider = req.body.provider === 'external' ? 'external' : 'careerz_jitsi';
  if (provider === 'external' && !/^https:\/\//i.test(req.body.externalMeetingUrl || '')) {
    throw new AppError('A secure external meeting URL is required.', 422);
  }
  const roomName = `careerz-${String(course._id).slice(-8)}-${crypto.randomBytes(10).toString('hex')}`;
  const session = await LiveClassSession.create({
    institution: institution._id,
    course: course._id,
    classSection: course.classSection,
    teacher: teacherId,
    timetableEntry: req.body.timetableEntry || null,
    title: String(req.body.title || `${course.title} Live Class`).trim(),
    scheduledStart,
    scheduledEnd,
    provider,
    roomName,
    externalMeetingUrl: provider === 'external' ? req.body.externalMeetingUrl : '',
    createdBy: req.user._id
  });
  await notifyCourseStudents(course._id, {
    title: `Live class scheduled: ${session.title}`,
    body: `${scheduledStart.toLocaleString()} — open My Classes at class time to join.`
  }, req.user._id);
  return created(res, await populated(LiveClassSession.findById(session._id)), 'Live class scheduled.');
});

const institutionList = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  assertInstitutionManager(institution, req.user._id);
  return ok(res, await populated(LiveClassSession.find({ institution: institution._id }).sort({ scheduledStart: -1 })));
});

const teacherList = asyncHandler(async (req, res) => {
  return ok(res, await populated(LiveClassSession.find({ teacher: req.user._id }).sort({ scheduledStart: -1 })));
});

const studentList = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ student: req.user._id, status: { $ne: 'dropped' } }).select('course');
  const courseIds = enrollments.map((row) => row.course);
  return ok(res, await populated(LiveClassSession.find({ course: { $in: courseIds }, status: { $ne: 'cancelled' } }).sort({ scheduledStart: -1 })));
});

const start = asyncHandler(async (req, res) => {
  const session = await LiveClassSession.findById(req.params.id);
  if (!session) throw new AppError('Live class not found.', 404);
  if (String(session.teacher) !== String(req.user._id)) throw new AppError('Only the assigned teacher can start this class.', 403);
  if (session.status === 'ended' || session.status === 'cancelled') throw new AppError('This class can no longer be started.', 409);
  session.status = 'live';
  session.startedAt ||= new Date();
  await session.save();
  await notifyCourseStudents(session.course, { title: `${session.title} is live now`, body: 'Open My Classes and select Join Class.' }, req.user._id);
  return ok(res, await populated(LiveClassSession.findById(session._id)), 'Live class started.');
});

const join = asyncHandler(async (req, res) => {
  const session = await LiveClassSession.findById(req.params.id);
  if (!session || session.status !== 'live') throw new AppError('This live class has not started or has ended.', 409);
  const enrollment = await Enrollment.findOne({ student: req.user._id, course: session.course, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  await assertInstitutionFeeAccess(req.user._id, session.institution);
  const now = new Date();
  const existing = session.participants.find((item) => String(item.student) === String(req.user._id));
  if (existing) {
    if (existing.leftAt) { existing.joinedAt = now; existing.leftAt = null; }
  } else {
    session.participants.push({
      student: req.user._id,
      joinedAt: now,
      attendanceStatus: now > new Date(session.scheduledStart.getTime() + 15 * 60000) ? 'late' : 'present'
    });
  }
  await session.save();
  return ok(res, session, 'Joined live class.');
});

const leave = asyncHandler(async (req, res) => {
  const session = await LiveClassSession.findById(req.params.id);
  if (!session) throw new AppError('Live class not found.', 404);
  const participant = session.participants.find((item) => String(item.student) === String(req.user._id));
  if (participant && !participant.leftAt) {
    participant.leftAt = new Date();
    participant.durationMinutes += Math.max(1, Math.round((participant.leftAt - participant.joinedAt) / 60000));
    await session.save();
  }
  return ok(res, null, 'Left live class.');
});

const end = asyncHandler(async (req, res) => {
  const session = await LiveClassSession.findById(req.params.id);
  if (!session) throw new AppError('Live class not found.', 404);
  if (String(session.teacher) !== String(req.user._id)) throw new AppError('Only the assigned teacher can end this class.', 403);
  if (session.status !== 'live') throw new AppError('This class is not live.', 409);
  const endedAt = new Date();
  session.participants.forEach((participant) => {
    if (!participant.leftAt) {
      participant.leftAt = endedAt;
      participant.durationMinutes += Math.max(1, Math.round((endedAt - participant.joinedAt) / 60000));
    }
  });
  session.status = 'ended';
  session.endedAt = endedAt;
  await session.save();

  const enrollments = await Enrollment.find({ course: session.course, status: { $ne: 'dropped' } }).select('student');
  const records = enrollments.map((row) => {
    const participant = session.participants.find((item) => String(item.student) === String(row.student));
    return {
      student: row.student,
      status: participant?.attendanceStatus || 'absent',
      method: 'live',
      checkedInAt: participant?.joinedAt || endedAt,
      reason: participant ? `Joined live class for ${participant.durationMinutes} minute(s).` : 'Did not join the live class.'
    };
  });
  await Attendance.create({ institution: session.institution, course: session.course, classSection: session.classSection, date: session.startedAt || session.scheduledStart, markedBy: req.user._id, records });
  emitToLiveVideoRoom(session._id, 'live-video:ended', { sessionId: String(session._id), endedAt });
  await notifyCourseStudents(session.course, { title: `Live class ended: ${session.title}`, body: 'Your attendance has been recorded.' }, req.user._id);
  return ok(res, session, 'Live class ended and attendance recorded.');
});

module.exports = { schedule, institutionList, teacherList, studentList, start, join, leave, end };
