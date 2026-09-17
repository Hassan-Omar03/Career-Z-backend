const ParentTeacherMeeting = require('../models/ParentTeacherMeeting');
const ParentChildLink = require('../models/ParentChildLink');
const StudentProfile = require('../models/StudentProfile');
const TimetableEntry = require('../models/TimetableEntry');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

async function assertApprovedParentOfStudent(parentId, studentId) {
  const link = await ParentChildLink.findOne({ parent: parentId, student: studentId, status: 'approved' });
  if (!link) throw new AppError('You are not linked to this student.', 403);
}

// Real teachers for a child — derived from the class's actual timetable, same source the
// student/parent Timetable pages already use. A parent can only request a PTM with one of
// these, never an arbitrary teacher.
async function getChildTeachers(studentId) {
  const profile = await StudentProfile.findOne({ user: studentId });
  if (!profile || !profile.classSection) return [];

  const entries = await TimetableEntry.find({ classSection: profile.classSection })
    .populate('teacher', 'fullName profilePhoto');

  const byTeacher = {};
  entries.forEach((e) => {
    if (!e.teacher) return;
    const key = e.teacher._id.toString();
    if (!byTeacher[key]) byTeacher[key] = { teacher: e.teacher, subjects: new Set(), institution: e.institution };
    if (e.subject) byTeacher[key].subjects.add(e.subject);
  });
  return Object.values(byTeacher).map((t) => ({ teacher: t.teacher, subjects: Array.from(t.subjects), institution: t.institution }));
}

// GET /api/parents/children/:studentId/teachers — the list a parent picks from when booking a PTM.
const listChildTeachers = asyncHandler(async (req, res) => {
  await assertApprovedParentOfStudent(req.user._id, req.params.studentId);
  const teachers = await getChildTeachers(req.params.studentId);
  return ok(res, teachers);
});

// POST /api/ptm — parent requests a meeting with a real teacher of their linked child.
const requestMeeting = asyncHandler(async (req, res) => {
  const { studentId, teacherId, requestedDate, mode, notes } = req.body;
  if (!studentId || !teacherId || !requestedDate) throw new AppError('studentId, teacherId and requestedDate are required.', 422);

  await assertApprovedParentOfStudent(req.user._id, studentId);

  const childTeachers = await getChildTeachers(studentId);
  const match = childTeachers.find((t) => t.teacher._id.toString() === teacherId);
  if (!match) throw new AppError('That teacher does not teach this student.', 403);

  const meeting = await ParentTeacherMeeting.create({
    parent: req.user._id,
    teacher: teacherId,
    student: studentId,
    institution: match.institution || null,
    subject: match.subjects[0] || '',
    requestedDate,
    mode: mode || 'video',
    notes: notes || ''
  });

  await notify(teacherId, {
    title: 'New Parent-Teacher Meeting request',
    body: `Requested for ${new Date(requestedDate).toLocaleString()}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, meeting, 'Meeting request sent. Waiting for the teacher to confirm.');
});

// GET /api/ptm/mine — works for both sides: parent sees their requests, teacher sees requests made to them.
const myMeetings = asyncHandler(async (req, res) => {
  const meetings = await ParentTeacherMeeting.find({ $or: [{ parent: req.user._id }, { teacher: req.user._id }] })
    .populate('parent', 'fullName')
    .populate('teacher', 'fullName')
    .populate('student', 'fullName')
    .sort({ requestedDate: -1 });
  return ok(res, meetings);
});

// PATCH /api/ptm/:id/respond — teacher confirms (with a real date + link/location) or declines.
const respondToMeeting = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  if (meeting.teacher.toString() !== req.user._id.toString()) throw new AppError('Only the requested teacher can respond to this.', 403);
  if (meeting.status !== 'pending') throw new AppError('This request has already been responded to.', 400);

  const { decision, confirmedDate, meetingLink, location } = req.body;
  if (!['confirmed', 'declined'].includes(decision)) throw new AppError('decision must be confirmed or declined.', 422);

  if (decision === 'confirmed') {
    meeting.confirmedDate = confirmedDate ? new Date(confirmedDate) : meeting.requestedDate;
    if (meeting.mode === 'video') meeting.meetingLink = meetingLink || '';
    else meeting.location = location || '';
  }
  meeting.status = decision;
  await meeting.save();

  await notify(meeting.parent, {
    title: decision === 'confirmed' ? 'Parent-Teacher Meeting confirmed' : 'Parent-Teacher Meeting declined',
    body: decision === 'confirmed' ? new Date(meeting.confirmedDate).toLocaleString() : 'The teacher declined this request.',
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, meeting, `Meeting ${decision}.`);
});

// PATCH /api/ptm/:id/cancel — either the parent or the teacher can cancel a pending/confirmed meeting.
const cancelMeeting = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  const isParty = [meeting.parent.toString(), meeting.teacher.toString()].includes(req.user._id.toString());
  if (!isParty) throw new AppError('You are not part of this meeting.', 403);
  if (!['pending', 'confirmed'].includes(meeting.status)) throw new AppError('This meeting can no longer be cancelled.', 400);

  meeting.status = 'cancelled';
  await meeting.save();

  const other = meeting.parent.toString() === req.user._id.toString() ? meeting.teacher : meeting.parent;
  await notify(other, { title: 'Parent-Teacher Meeting cancelled', body: '', sentBy: req.user._id }).catch(() => {});

  return ok(res, meeting, 'Meeting cancelled.');
});

module.exports = { listChildTeachers, requestMeeting, myMeetings, respondToMeeting, cancelMeeting };
