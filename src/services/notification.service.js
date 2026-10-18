const Notification = require('../models/Notification');
const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const { sendEmail, noticeEmailTemplate } = require('./email.service');
const { emitToUser } = require('../realtime/socket');
const crypto = require('crypto');
const { absolute } = require('../utils/siteUrl');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNSUBSCRIBE_LABEL = { jobAlertsEmail: 'job alert emails', weeklyDigest: 'the weekly job digest', applicationEmails: 'application update emails', scholarshipAlertsEmail: 'scholarship alert emails' };

async function unsubscribeLink(user, preference) {
  if (!user.unsubscribeToken) {
    user.unsubscribeToken = crypto.randomBytes(24).toString('hex');
    await User.updateOne({ _id: user._id }, { $set: { unsubscribeToken: user.unsubscribeToken } });
  }
  return absolute(`/api/notifications/unsubscribe?token=${user.unsubscribeToken}&type=${preference}`);
}

// Creates an in-app notification, and optionally emails it too.
// Never throws on email failure — a broken SMTP config must not block the in-app notification.
//   link       — where the notification opens inside the site (also the email button).
//   dedupeKey  — the same (user, key) is delivered only once (e.g. one alert per job).
//   inAppPreference / emailPreference — a notificationPreferences key the person can switch off;
//   an email sent under a preference carries a one-click unsubscribe link for it.
async function notify(userId, { title, body = '', sentBy = null, link = '', category = '', dedupeKey } = {}, { email = false, toAddress = null, ctaUrl = null, ctaLabel = null, inAppPreference = null, emailPreference = null } = {}) {
  let user = null;
  if (inAppPreference || emailPreference) user = await User.findById(userId).select('email emailVerified notificationPreferences unsubscribeToken');
  const inAppOn = !inAppPreference || user?.notificationPreferences?.[inAppPreference] !== false;
  let notification;
  try {
    notification = await Notification.create({ user: userId, title, body, sentBy, link, category, ...(dedupeKey ? { dedupeKey } : {}), muted: !inAppOn });
  } catch (err) {
    if (err?.code === 11000 && dedupeKey) return null; // already delivered for this event
    throw err;
  }

  if (inAppOn) {
  // Live push — every notify() call reaches any open tab instantly (bell badge, toast) instead
  // of waiting for the next poll/refresh. Silently a no-op if that user has no socket connected.
  emitToUser(userId, 'notification:new', {
    _id: notification._id, title, body, link, createdAt: notification.createdAt, read: false
  });

  // Background push — reaches the user's subscribed browsers even with no tab open. Best-effort.
  require('./push.service').pushToUser(userId, { title, body }).catch((err) => {
    console.error('[notification.service] Web push failed:', err.message);
  });
  }

  const emailOn = email && (!emailPreference || user?.notificationPreferences?.[emailPreference] !== false);
  if (emailOn) {
    try {
      const target = user || (await User.findById(userId).select('email unsubscribeToken'));
      const address = toAddress || target?.email;
      if (!address) throw new Error('No email address on file.');
      const button = ctaUrl || (link ? absolute(link) : null);
      const footer = emailPreference && target ? `You receive this because ${escapeHtml(UNSUBSCRIBE_LABEL[emailPreference] || 'these emails')} are on in your CareerZ notification settings. <a href="${await unsubscribeLink(target, emailPreference)}" style="color:#8A9490;">Unsubscribe</a>` : null;
      await sendEmail({
        to: address,
        subject: title,
        text: `${body}${button ? `\n\n${button}` : ''}`,
        html: noticeEmailTemplate({ heading: escapeHtml(title), body: escapeHtml(body), ctaUrl: button, ctaLabel: escapeHtml(ctaLabel || (link ? 'Open on CareerZ' : '')) || undefined, footer })
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
  const allowed=await Promise.all(links.map(l=>require('./familyAccess.service').canReadSchoolRecords(l)));
  return notifyMany(links.filter((l,i)=>allowed[i]).map(l=>l.parent),payload,options);
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

module.exports = { notify, notifyMany, notifyParentsOfStudent, notifyAdmins, escapeHtml };
