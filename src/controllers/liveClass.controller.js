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
const { assertFeeAccessForCapability } = require('../utils/feeAccess');
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
  const provider = course.studyMode !== 'physical' && req.body.provider === 'external' ? 'external' : 'careerz_jitsi';
  if (provider === 'external' && !/^https:\/\//i.test(req.body.externalMeetingUrl || '')) {
    throw new AppError('A secure external meeting URL is required.', 422);
  }
  const roomName = `careerz-${String(course._id).slice(-8)}-${crypto.randomBytes(10).toString('hex')}`;
  const session = await LiveClassSession.create({
    institution: institution._id,
    course: course._id,
    classSection: course.classSection,
    teacher: teacherId,
    mode: ['physical','hybrid'].includes(course.studyMode) ? course.studyMode : 'online',
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
  if (session.mode === 'physical') throw new AppError('Physical classes use on-campus attendance.', 409);
  const enrollment = await Enrollment.findOne({ student: req.user._id, course: session.course, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  await assertFeeAccessForCapability(req.user._id, session.institution, 'live_classes');
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
  if (session.status === 'ended' && await Attendance.exists({liveClassSession:session._id})) return ok(res,session,'Attendance already recorded.');
  if (!['live','ended'].includes(session.status)) throw new AppError('This class is not live.',409);
  const wasLive = session.status === 'live';
  const endedAt = session.endedAt || new Date();
  session.participants.forEach((participant) => {
    if (!participant.leftAt) {
      participant.leftAt = endedAt;
      participant.durationMinutes += Math.max(1, Math.round((endedAt - participant.joinedAt) / 60000));
    }
  });
  session.status = 'ended';
  session.endedAt = endedAt;
  const claimed = await LiveClassSession.findOneAndUpdate({_id:session._id,status:'live'},{$set:{status:'ended',endedAt,participants:session.participants}},{new:true});
  if (!claimed && wasLive) throw new AppError('Class already ended.',409);

  const enrollments = await Enrollment.find({ course: session.course, status: { $ne: 'dropped' } }).select('student');
  const records = enrollments.map((row) => {
    const physical = session.physicalAttendance?.find(r=>String(r.student)===String(row.student));
    if (physical && (!['absent'].includes(physical.status) || !session.participants.some(p=>String(p.student)===String(row.student)))) return {student:row.student,status:physical.status,method:'manual',checkedInAt:endedAt,reason:'Physical attendance marked by assigned teacher.'};
    const participant = session.participants.find((item) => String(item.student) === String(row.student));
    return {
      student: row.student,
      status: participant?.attendanceStatus || 'absent',
      method: 'live',
      checkedInAt: participant?.joinedAt || endedAt,
      reason: participant ? `Joined live class for ${participant.durationMinutes} minute(s).` : 'Did not join the live class.'
    };
  });
  await Attendance.findOneAndUpdate({liveClassSession:session._id},{$setOnInsert:{liveClassSession:session._id,institution:session.institution,course:session.course,classSection:session.classSection,date:session.startedAt||session.scheduledStart,markedBy:req.user._id,records}},{upsert:true,new:true,runValidators:true});
  await require('../utils/courseProgress').recalculateEnrollmentProgressForCourse(session.course);
  emitToLiveVideoRoom(session._id, 'live-video:ended', { sessionId: String(session._id), endedAt });
  await notifyCourseStudents(session.course, { title: `Live class ended: ${session.title}`, body: 'Your attendance has been recorded.' }, req.user._id);
  return ok(res, session, 'Live class ended and attendance recorded.');
});


const physicalAttendance=asyncHandler(async(req,res)=>{const s=await LiveClassSession.findById(req.params.id);if(!s)throw new AppError('Session not found.',404);if(String(s.teacher)!==String(req.user._id))throw new AppError('Assigned teacher required.',403);if(!['physical','hybrid'].includes(s.mode)||s.status!=='live')throw new AppError('Physical/hybrid live session required.',409);if(!Array.isArray(req.body.records)||req.body.records.length>500)throw new AppError('Attendance records required.',422);const ids=await Enrollment.find({course:s.course,status:{$ne:'dropped'}}).distinct('student');const allowed=new Set(ids.map(String));if(req.body.records.some(r=>!allowed.has(String(r.student))||!['present','late','absent','excused'].includes(r.status))||new Set(req.body.records.map(r=>String(r.student))).size!==req.body.records.length)throw new AppError('Valid, unique enrolled students required.',422);s.physicalAttendance=req.body.records;await s.save();return ok(res,s);});
const roster=asyncHandler(async(req,res)=>{const s=await LiveClassSession.findById(req.params.id);if(!s||String(s.teacher)!==String(req.user._id))throw new AppError('Assigned teacher required.',403);const rows=await Enrollment.find({course:s.course,status:{$ne:'dropped'}}).populate('student','fullName');return ok(res,{students:rows.map(e=>e.student),records:s.physicalAttendance,mode:s.mode,status:s.status});});
const recording=asyncHandler(async(req,res)=>{const s=await LiveClassSession.findById(req.params.id);if(!s||String(s.teacher)!==String(req.user._id))throw new AppError('Assigned teacher required.',403);if(!/^https:\/\//.test(req.body.url||''))throw new AppError('Upload recording to HTTPS storage first.',422);s.recordingUrl=req.body.url;await s.save();const Lesson=require('../models/Lesson');if(!await Lesson.exists({course:s.course,videoUrl:s.recordingUrl})){const staged=(await Course.findById(s.course)).approvalWorkflow==='staged';await Lesson.create({course:s.course,title:s.title+' — recording',videoUrl:s.recordingUrl,published:!staged,approvalStatus:staged?'draft':'approved'});await require('../utils/courseProgress').recalculateEnrollmentProgressForCourse(s.course);}return ok(res,s);});
module.exports = { physicalAttendance,roster,recording,schedule, institutionList, teacherList, studentList, start, join, leave, end };
