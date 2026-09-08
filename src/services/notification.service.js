const Notification = require('../models/Notification');
const { sendEmail } = require('./email.service');

// Creates an in-app notification, and optionally emails it too.
// Never throws on email failure — a broken SMTP config must not block the in-app notification.
async function notify(userId, { title, body = '', sentBy = null }, { email = false, toAddress = null } = {}) {
  const notification = await Notification.create({ user: userId, title, body, sentBy });

  if (email && toAddress) {
    try {
      await sendEmail({ to: toAddress, subject: title, text: body, html: `<p>${body}</p>` });
    } catch (err) {
      console.error('[notification.service] Failed to email notification:', err.message);
    }
  }

  return notification;
}

async function notifyMany(userIds, payload, options) {
  return Promise.all(userIds.map((id) => notify(id, payload, options)));
}

module.exports = { notify, notifyMany };
