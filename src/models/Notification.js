const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    read: { type: Boolean, default: false },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Where clicking the notification goes inside the site, e.g. /jobs/<id>.
    link: { type: String, default: '' },
    category: { type: String, default: '' }, // job_alert, application, scholarship_alert, ...
    // One notification per (user, event): a second notify() with the same key is skipped.
    dedupeKey: { type: String, default: undefined },
    // Kept only to stop a repeat alert when the person turned in-app alerts off; never listed.
    muted: { type: Boolean, default: false }
  },
  { timestamps: true }
);
notificationSchema.index({ user: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

module.exports = mongoose.model('Notification', notificationSchema);
