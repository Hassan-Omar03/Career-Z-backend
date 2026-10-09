// Background (Web Push) notifications. Configured with VAPID keys; with none set this is a silent
// no-op, so in-app/socket/email delivery is never affected.
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let configured = null;
function isPushConfigured() {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  if (configured) webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@careerz.pk', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return configured;
}

function publicKey() {
  return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

// Sends to every browser the user subscribed. Expired subscriptions (404/410) are removed.
async function pushToUser(userId, { title, body = '', url = '/dashboard' }) {
  if (!isPushConfigured()) return { sent: 0 };
  const subscriptions = await PushSubscription.find({ user: userId });
  let sent = 0;
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        JSON.stringify({ title, body, url }),
        { TTL: 24 * 60 * 60 }
      );
      sent += 1;
      await PushSubscription.updateOne({ _id: sub._id }, { $set: { lastSuccessAt: new Date() } });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) await PushSubscription.deleteOne({ _id: sub._id });
      else console.error('[push.service] Web push failed:', error.statusCode || error.message);
    }
  }));
  return { sent };
}

module.exports = { isPushConfigured, publicKey, pushToUser, _resetForTests: () => { configured = null; } };
