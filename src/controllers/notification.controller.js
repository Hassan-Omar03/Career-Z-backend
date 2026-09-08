const Notification = require('../models/Notification');
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const ParentChildLink = require('../models/ParentChildLink');
const { notifyMany } = require('../services/notification.service');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// GET /api/notifications/mine
const listMine = asyncHandler(async (req, res) => {
  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);
  return ok(res, notifications);
});

// PATCH /api/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, user: req.user._id });
  if (!notification) throw new AppError('Notification not found.', 404);
  notification.read = true;
  await notification.save();
  return ok(res, notification);
});

// PATCH /api/notifications/mine/read-all
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
  return ok(res, { marked: true });
});

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
}

// POST /api/institutions/:id/notifications/broadcast
// Covers "Communication Center" / "Emergency Notification" from the spec — in-app + email,
// scoped to the institution's own students/teachers/parents/staff (no SMS/push — those need a paid provider).
const broadcast = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { audience, title, body } = req.body;
  if (!title || !audience) throw new AppError('audience and title are required.', 422);

  const studentProfiles = await StudentProfile.find({ primaryInstitution: institution._id }).select('user');
  const studentUserIds = studentProfiles.map((p) => p.user);

  let recipientIds = [];
  if (audience === 'students' || audience === 'all') recipientIds.push(...studentUserIds);
  if (audience === 'teachers' || audience === 'all') {
    const teacherProfiles = await TeacherProfile.find({ institutions: institution._id }).select('user');
    recipientIds.push(...teacherProfiles.map((p) => p.user));
  }
  if (audience === 'parents' || audience === 'all') {
    const links = await ParentChildLink.find({ student: { $in: studentUserIds }, status: 'approved' }).select('parent');
    recipientIds.push(...links.map((l) => l.parent));
  }
  if (audience === 'staff' || audience === 'all') {
    recipientIds.push(...institution.staff.map((s) => s.user));
  }

  const uniqueIds = Array.from(new Set(recipientIds.map((id) => id.toString())));
  await notifyMany(uniqueIds, { title, body: body || '', sentBy: req.user._id });

  return ok(res, { sentTo: uniqueIds.length }, `Notification sent to ${uniqueIds.length} recipient(s).`);
});

module.exports = { listMine, markRead, markAllRead, broadcast };
