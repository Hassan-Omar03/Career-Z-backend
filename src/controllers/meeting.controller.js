const Meeting = require('../models/Meeting');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

function assertStaffOrOwner(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You are not staff at this institution.', 403);
}

// POST /api/meetings — a representative schedules a consultation with a student.
const createMeeting = asyncHandler(async (req, res) => {
  const { institution, student, program, scheduledDate, mode, location, meetingLink, relatedInquiry, relatedApplication } = req.body;
  if (!institution || !student || !scheduledDate) throw new AppError('institution, student and scheduledDate are required.', 422);

  const inst = await Institution.findById(institution);
  if (!inst) throw new AppError('Institution not found.', 404);
  assertStaffOrOwner(inst, req.user._id);

  const meeting = await Meeting.create({
    institution, representative: req.user._id, student, program: program || '',
    scheduledDate, mode: mode || 'video', location: location || '', meetingLink: meetingLink || '',
    relatedInquiry: relatedInquiry || null, relatedApplication: relatedApplication || null
  });

  await notify(student, {
    title: `Meeting scheduled with ${inst.name}`,
    body: `${new Date(scheduledDate).toLocaleString()} — ${mode === 'physical' ? location : (meetingLink || 'online')}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, meeting, 'Meeting scheduled.');
});

// GET /api/meetings/mine — works for both the representative and the student side.
const myMeetings = asyncHandler(async (req, res) => {
  const meetings = await Meeting.find({ $or: [{ representative: req.user._id }, { student: req.user._id }] })
    .populate('institution', 'name')
    .populate('representative', 'fullName')
    .populate('student', 'fullName email')
    .sort({ scheduledDate: 1 });
  return ok(res, meetings);
});

// PATCH /api/meetings/:id/status
const updateMeetingStatus = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findById(req.params.id);
  if (!meeting) throw new AppError('Meeting not found.', 404);
  if (meeting.representative.toString() !== req.user._id.toString()) throw new AppError('You did not schedule this meeting.', 403);

  const { status } = req.body;
  if (!['scheduled', 'completed', 'cancelled'].includes(status)) throw new AppError('Invalid status.', 422);
  meeting.status = status;
  await meeting.save();
  return ok(res, meeting, 'Meeting updated.');
});

module.exports = { createMeeting, myMeetings, updateMeetingStatus };
