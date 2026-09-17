const Notification = require('../models/Notification');
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const { notifyMany } = require('../services/notification.service');
const smsService = require('../services/sms.service');
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
// Covers "Communication Center" / "Emergency Notification" from the spec — in-app + email always;
// SMS/WhatsApp additionally sent (real Twilio, BYOK) when `channels` includes them and the
// institution has connected its own Twilio account via comms-credential.
const broadcast = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { audience, title, body, channels } = req.body;
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

  let smsResult = null;
  let whatsappResult = null;
  const wantsSms = Array.isArray(channels) && channels.includes('sms');
  const wantsWhatsapp = Array.isArray(channels) && channels.includes('whatsapp');
  if (wantsSms || wantsWhatsapp) {
    const recipients = await User.find({ _id: { $in: uniqueIds }, phone: { $exists: true, $ne: '' } }).select('phone');
    const phones = recipients.map((u) => u.phone);
    const text = body ? `${title}\n${body}` : title;
    if (wantsSms && phones.length) smsResult = await smsService.sendBulk(institution._id, 'sms', phones, text).catch((e) => ({ sent: 0, failed: phones.length, error: e.message }));
    if (wantsWhatsapp && phones.length) whatsappResult = await smsService.sendBulk(institution._id, 'whatsapp', phones, text).catch((e) => ({ sent: 0, failed: phones.length, error: e.message }));
  }

  return ok(res, { sentTo: uniqueIds.length, smsResult, whatsappResult }, `Notification sent to ${uniqueIds.length} recipient(s).`);
});

// ---- SMS/WhatsApp provider (Twilio, BYOK) ----

const getCommsStatus = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const status = await require('../services/sms.service').getStatus(institution._id);
  return ok(res, status);
});

const saveCommsCredential = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { accountSid, authToken, smsFromNumber, whatsappFromNumber } = req.body;
  if (!accountSid || !authToken) throw new AppError('accountSid and authToken are required.', 422);
  if (!smsFromNumber && !whatsappFromNumber) throw new AppError('At least one of smsFromNumber or whatsappFromNumber is required.', 422);

  await require('../services/sms.service').saveCredential(institution._id, req.user._id, { accountSid, authToken, smsFromNumber, whatsappFromNumber });
  return ok(res, { configured: true }, 'Twilio connected.');
});

const removeCommsCredential = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  await require('../services/sms.service').removeCredential(institution._id);
  return ok(res, null, 'Twilio disconnected.');
});

// POST /api/notifications/platform-announcement — super_admin-only, platform-wide. Covers Donor
// Notifications item "Platform announcement" (and is equally usable for any other role's feed,
// since it's the same shared Notification model/UI everyone already reads from).
const platformAnnouncement = asyncHandler(async (req, res) => {
  const { title, body, roles } = req.body;
  if (!title) throw new AppError('title is required.', 422);

  const filter = roles && roles.length > 0 ? { roles: { $in: roles } } : {};
  const users = await User.find(filter).select('_id');
  await notifyMany(users.map((u) => u._id), { title: `Platform announcement: ${title}`, body: body || '', sentBy: req.user._id });

  return ok(res, { sentTo: users.length }, `Announcement sent to ${users.length} user(s).`);
});

module.exports = { listMine, markRead, markAllRead, broadcast, platformAnnouncement, getCommsStatus, saveCommsCredential, removeCommsCredential };
