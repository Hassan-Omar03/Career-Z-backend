const mongoose = require('mongoose');

// A browser's Web Push subscription (one per device/browser). Lets notifications reach a user
// even when no CareerZ tab is open — the service worker shows them as system notifications.
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  userAgent: { type: String, default: '' },
  lastSuccessAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
