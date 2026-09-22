const Notification = require('../models/Notification');
const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const { sendEmail, noticeEmailTemplate } = require('./email.service');
const { emitToUser } = require('../realtime/socket');

// Creates an in-app notification, and optionally emails it too.
// Never throws on email failure — a broken SMTP config must not block the in-app notification.
async function notify(userId, { title, body = '', sentBy = null }, { email = false, toAddress = null } = {}) {
  const notification = await Notification.create({ user: userId, title, body, sentBy });

  // Live push — every notify() call reaches any open tab instantly (bell badge, toast) instead
  // of waiting for the next poll/refresh. Silently a no-op if that user has no socket connected.
  emitToUser(userId, 'notification:new', {
    _id: notification._id, title, body, createdAt: notification.createdAt, read: false
  });

  if (email && toAddress) {
    try {
      await sendEmail({
        to: toAddress,
        subject: title,
        text: body,
        html: noticeEmailTemplate({ heading: title, body })
      });
    } catch (err) {
      console.error('[notification.service] Failed to email notification:', err.message);
    }
  }

  return notification;
}

async function notifyMany(userIds, payload, options) {
  return Promise.all(userIds.map((id) => notify(id, payload, options)));
}

// Fans a notification out to every parent/guardian approved to see this student
// (child absence, new result, fee due — the parent dashboard's Notifications feed).
async function notifyParentsOfStudent(studentId, payload, options) {
  const links = await ParentChildLink.find({ student: studentId, status: 'approved' });
  if (links.length === 0) return [];
  return notifyMany(links.map((l) => l.parent), payload, options);
}

// Fans a notification (in-app + email) out to every Admin/Super Admin — used whenever a new
// account/role/institution submits documents that need review, so Super Admin is always
// connected to every account type's approval pipeline (spec: no account goes live without
// admin review of its documents).
async function notifyAdmins(payload) {
  const admins = await User.find({ roles: { $in: ['admin', 'super_admin'] } }).select('email');
  if (admins.length === 0) return [];
  return Promise.all(
    admins.map((admin) => notify(admin._id, payload, { email: true, toAddress: admin.email }))
  );
}

module.exports = { notify, notifyMany, notifyParentsOfStudent, notifyAdmins };
