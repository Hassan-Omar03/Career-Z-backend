const ParentTeacherMeeting = require('../models/ParentTeacherMeeting');
const ParentChildLink = require('../models/ParentChildLink');
const StudentProfile = require('../models/StudentProfile');
const TimetableEntry = require('../models/TimetableEntry');
const PtmRecurringSchedule = require('../models/PtmRecurringSchedule');
const PtmEscalation = require('../models/PtmEscalation');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

const ESCALATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const ESCALATION_THRESHOLD = 3;

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

// Spec: "Automatic escalation — parent baar baar PTM miss/no-respond kare to institution ko
// automatically flag ho." Fires reactively right when a no-show or a parent-side cancellation is
// recorded (real events, never guessed) — no background scheduler exists, so this runs inline
// instead of on a poll.
async function checkAndEscalate(parentId, institutionId) {
  if (!institutionId) return; // independent-teacher PTMs have no institution to escalate to
  const since = new Date(Date.now() - ESCALATION_WINDOW_MS);
  const problematic = await ParentTeacherMeeting.find({
    parent: parentId, institution: institutionId, createdAt: { $gte: since },
    $or: [{ noShow: true }, { status: 'cancelled', cancelledBy: parentId }]
  });
  if (problematic.length < ESCALATION_THRESHOLD) return;

  const existingOpen = await PtmEscalation.findOne({ parent: parentId, institution: institutionId, status: 'open' });
  const meetingIds = problematic.map((m) => m._id);
  if (existingOpen) {
    const merged = Array.from(new Set([...existingOpen.meetings.map(String), ...meetingIds.map(String)]));
    if (merged.length !== existingOpen.meetings.length) {
      existingOpen.meetings = merged;
      existingOpen.reason = `${merged.length} missed/cancelled Parent-Teacher Meetings in the last 90 days.`;
      await existingOpen.save();
    }
    return;
  }

  const reason = `${problematic.length} missed/cancelled Parent-Teacher Meetings in the last 90 days.`;
  await PtmEscalation.create({ parent: parentId, institution: institutionId, reason, meetings: meetingIds });
  const institution = await Institution.findById(institutionId);
  if (institution) {
    await notify(institution.owner, { title: 'Parent PTM engagement flag', body: reason, sentBy: null }).catch(() => {});
  }
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
  meeting.cancelledBy = req.user._id;
  await meeting.save();

  const other = meeting.parent.toString() === req.user._id.toString() ? meeting.teacher : meeting.parent;
  await notify(other, { title: 'Parent-Teacher Meeting cancelled', body: '', sentBy: req.user._id }).catch(() => {});

  if (meeting.parent.toString() === req.user._id.toString()) {
    await checkAndEscalate(meeting.parent, meeting.institution);
  }

  return ok(res, meeting, 'Meeting cancelled.');
});

// PATCH /api/ptm/:id/complete — either party marks a confirmed meeting as having actually happened.
const completeMeeting = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  const isParty = [meeting.parent.toString(), meeting.teacher.toString()].includes(req.user._id.toString());
  if (!isParty) throw new AppError('You are not part of this meeting.', 403);
  if (meeting.status !== 'confirmed') throw new AppError('Only a confirmed meeting can be marked completed.', 400);

  meeting.status = 'completed';
  await meeting.save();
  return ok(res, meeting, 'Meeting marked completed.');
});

// PATCH /api/ptm/:id/no-show — teacher marks that the parent never showed up. The real, explicit
// signal behind PTM escalation (spec: "parent baar baar miss kare").
const markNoShow = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  if (meeting.teacher.toString() !== req.user._id.toString()) throw new AppError('Only the teacher can mark a no-show.', 403);
  if (meeting.status !== 'confirmed') throw new AppError('Only a confirmed meeting can be marked as a no-show.', 400);

  meeting.status = 'completed';
  meeting.noShow = true;
  await meeting.save();

  await checkAndEscalate(meeting.parent, meeting.institution);
  return ok(res, meeting, 'Marked as a no-show.');
});

// PATCH /api/ptm/:id/minutes — meeting minutes, editable by either party once the meeting is done.
const updateMinutes = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  const isParty = [meeting.parent.toString(), meeting.teacher.toString()].includes(req.user._id.toString());
  if (!isParty) throw new AppError('You are not part of this meeting.', 403);
  if (meeting.status !== 'completed') throw new AppError('Minutes can only be added once the meeting is completed.', 400);

  meeting.minutes = req.body.minutes || '';
  meeting.minutesUpdatedAt = new Date();
  await meeting.save();

  const other = meeting.parent.toString() === req.user._id.toString() ? meeting.teacher : meeting.parent;
  await notify(other, { title: 'Meeting minutes updated', sentBy: req.user._id }).catch(() => {});
  return ok(res, meeting, 'Minutes saved.');
});

// POST /api/ptm/:id/action-items — a follow-up task either party assigns to parent or teacher.
const addActionItem = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  const isParty = [meeting.parent.toString(), meeting.teacher.toString()].includes(req.user._id.toString());
  if (!isParty) throw new AppError('You are not part of this meeting.', 403);
  if (meeting.status !== 'completed') throw new AppError('Action items can only be added once the meeting is completed.', 400);

  const { text, assignedTo } = req.body;
  if (!text?.trim() || !['parent', 'teacher'].includes(assignedTo)) throw new AppError('text and a valid assignedTo are required.', 422);

  meeting.actionItems.push({ text: text.trim(), assignedTo, createdBy: req.user._id });
  await meeting.save();

  const assigneeId = assignedTo === 'parent' ? meeting.parent : meeting.teacher;
  await notify(assigneeId, { title: 'New PTM follow-up task', body: text.trim(), sentBy: req.user._id }).catch(() => {});
  return created(res, meeting, 'Action item added.');
});

// PATCH /api/ptm/:id/action-items/:itemId — toggle done.
const toggleActionItem = asyncHandler(async (req, res) => {
  const meeting = await ParentTeacherMeeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting request not found.', 404);
  const isParty = [meeting.parent.toString(), meeting.teacher.toString()].includes(req.user._id.toString());
  if (!isParty) throw new AppError('You are not part of this meeting.', 403);

  const item = meeting.actionItems.id(req.params.itemId);
  if (!item) throw new AppError('Action item not found.', 404);
  item.done = req.body.done !== false;
  await meeting.save();
  return ok(res, meeting, 'Updated.');
});

// ---- Recurring PTM schedules (spec: "teacher ek baar recurring slot set kare, automatically
// repeat ho") — a real recurrence RULE; occurrence dates are computed live, not pre-generated
// ghost meetings (no background scheduler exists in this codebase).

function computeUpcomingOccurrences(schedule, count = 4) {
  const [hh, mm] = schedule.time.split(':').map(Number);
  const now = new Date();
  const results = [];

  if (schedule.frequency === 'weekly') {
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    while (d.getDay() !== schedule.dayOfWeek || d <= now) d.setDate(d.getDate() + 1);
    for (let i = 0; i < count; i++) { results.push(new Date(d)); d.setDate(d.getDate() + 7); }
  } else {
    let d = new Date(now.getFullYear(), now.getMonth(), schedule.dayOfMonth, hh, mm, 0, 0);
    if (d <= now) d.setMonth(d.getMonth() + 1);
    for (let i = 0; i < count; i++) { results.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
  }
  return results;
}

// POST /api/ptm/recurring — teacher creates a recurring availability slot.
const createRecurringSchedule = asyncHandler(async (req, res) => {
  const { title, frequency, dayOfWeek, dayOfMonth, time, mode, meetingLink, location, institutionId } = req.body;
  if (!title?.trim() || !['weekly', 'monthly'].includes(frequency) || !time) {
    throw new AppError('title, frequency (weekly/monthly) and time are required.', 422);
  }
  if (frequency === 'weekly' && (dayOfWeek === undefined || dayOfWeek < 0 || dayOfWeek > 6)) {
    throw new AppError('dayOfWeek (0-6) is required for a weekly schedule.', 422);
  }
  if (frequency === 'monthly' && (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new AppError('dayOfMonth (1-28) is required for a monthly schedule.', 422);
  }

  const schedule = await PtmRecurringSchedule.create({
    teacher: req.user._id, institution: institutionId || null, title: title.trim(),
    frequency, dayOfWeek: frequency === 'weekly' ? dayOfWeek : null, dayOfMonth: frequency === 'monthly' ? dayOfMonth : null,
    time, mode: mode || 'video', meetingLink: meetingLink || '', location: location || ''
  });
  return created(res, schedule, 'Recurring schedule created.');
});

// GET /api/ptm/recurring/mine — teacher's own schedules.
const myRecurringSchedules = asyncHandler(async (req, res) => {
  const schedules = await PtmRecurringSchedule.find({ teacher: req.user._id }).sort({ createdAt: -1 });
  return ok(res, schedules.map((s) => ({ ...s.toObject(), upcoming: s.active ? computeUpcomingOccurrences(s) : [] })));
});

// PATCH /api/ptm/recurring/:id — teacher activates/deactivates their own schedule.
const setRecurringScheduleActive = asyncHandler(async (req, res) => {
  const schedule = await PtmRecurringSchedule.findById(req.params.id);
  if (!schedule) throw new AppError('Schedule not found.', 404);
  if (schedule.teacher.toString() !== req.user._id.toString()) throw new AppError('This is not your schedule.', 403);
  schedule.active = req.body.active !== false;
  await schedule.save();
  return ok(res, schedule, schedule.active ? 'Schedule activated.' : 'Schedule deactivated.');
});

// GET /api/ptm/recurring/for-child/:studentId — recurring slots from this child's real teachers,
// with the next real occurrence dates a parent can book into.
const childRecurringSchedules = asyncHandler(async (req, res) => {
  await assertApprovedParentOfStudent(req.user._id, req.params.studentId);
  const childTeachers = await getChildTeachers(req.params.studentId);
  const teacherIds = childTeachers.map((t) => t.teacher._id);

  const schedules = await PtmRecurringSchedule.find({ teacher: { $in: teacherIds }, active: true }).populate('teacher', 'fullName');
  const booked = await ParentTeacherMeeting.find({ recurringSchedule: { $in: schedules.map((s) => s._id) }, status: { $in: ['confirmed', 'completed'] } }).select('recurringSchedule confirmedDate');

  return ok(res, schedules.map((s) => {
    const takenDates = new Set(booked.filter((b) => b.recurringSchedule?.toString() === s._id.toString()).map((b) => new Date(b.confirmedDate).getTime()));
    return {
      ...s.toObject(),
      upcoming: computeUpcomingOccurrences(s).filter((d) => !takenDates.has(d.getTime()))
    };
  }));
});

// POST /api/ptm/recurring/:id/book — parent books directly into a real upcoming occurrence.
// Pre-confirmed immediately (it's the teacher's own declared availability, no separate
// confirm step needed) — a real ParentTeacherMeeting for that exact date.
const bookRecurringOccurrence = asyncHandler(async (req, res) => {
  const schedule = await PtmRecurringSchedule.findById(req.params.id);
  if (!schedule || !schedule.active) throw new AppError('Schedule not found or no longer active.', 404);

  const { studentId, occurrenceDate } = req.body;
  if (!studentId || !occurrenceDate) throw new AppError('studentId and occurrenceDate are required.', 422);
  await assertApprovedParentOfStudent(req.user._id, studentId);

  const childTeachers = await getChildTeachers(studentId);
  const match = childTeachers.find((t) => t.teacher._id.toString() === schedule.teacher.toString());
  if (!match) throw new AppError('That teacher does not teach this student.', 403);

  const upcoming = computeUpcomingOccurrences(schedule);
  const target = new Date(occurrenceDate);
  if (!upcoming.some((d) => d.getTime() === target.getTime())) {
    throw new AppError('That is not one of this schedule\'s real upcoming occurrence times.', 422);
  }
  const alreadyBooked = await ParentTeacherMeeting.findOne({ recurringSchedule: schedule._id, confirmedDate: target, status: { $in: ['confirmed', 'completed'] } });
  if (alreadyBooked) throw new AppError('That slot was just booked by someone else.', 409);

  const meeting = await ParentTeacherMeeting.create({
    parent: req.user._id, teacher: schedule.teacher, student: studentId,
    institution: schedule.institution || match.institution || null,
    subject: match.subjects[0] || '', requestedDate: target, confirmedDate: target,
    mode: schedule.mode, meetingLink: schedule.meetingLink, location: schedule.location,
    status: 'confirmed', recurringSchedule: schedule._id
  });

  await notify(schedule.teacher, { title: `Recurring PTM booked: ${schedule.title}`, body: target.toLocaleString(), sentBy: req.user._id }).catch(() => {});
  return created(res, meeting, 'Booked.');
});

// ---- Escalation review (institution side) ----

function assertOwnerOrStaff(institution, userId) {
  if (institution.owner.toString() === userId.toString()) return true;
  return institution.staff.some((s) => s.user.toString() === userId.toString());
}

// GET /api/ptm/escalations/:institutionId
const listEscalations = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (!assertOwnerOrStaff(institution, req.user._id)) throw new AppError('You do not have access to this institution\'s PTM flags.', 403);

  const escalations = await PtmEscalation.find({ institution: institution._id }).populate('parent', 'fullName email').sort({ createdAt: -1 });
  return ok(res, escalations);
});

// PATCH /api/ptm/escalations/:id/acknowledge
const acknowledgeEscalation = asyncHandler(async (req, res) => {
  const escalation = await PtmEscalation.findById(req.params.id);
  if (!escalation) throw new AppError('Flag not found.', 404);
  const institution = await Institution.findById(escalation.institution);
  if (!institution || !assertOwnerOrStaff(institution, req.user._id)) throw new AppError('You do not have access to this flag.', 403);

  escalation.status = 'acknowledged';
  escalation.acknowledgedBy = req.user._id;
  escalation.acknowledgedAt = new Date();
  await escalation.save();
  return ok(res, escalation, 'Acknowledged.');
});

module.exports = {
  listChildTeachers, requestMeeting, myMeetings, respondToMeeting, cancelMeeting,
  completeMeeting, markNoShow, updateMinutes, addActionItem, toggleActionItem,
  createRecurringSchedule, myRecurringSchedules, setRecurringScheduleActive,
  childRecurringSchedules, bookRecurringOccurrence,
  listEscalations, acknowledgeEscalation
};
