const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { JOB_CATEGORIES } = require('../models/Job');
const { escapeHtml } = require('../services/notification.service');

// Notification settings (Master 35 Notification Center, Job Marketplace 19 job alerts): what the
// person receives in the app and by email, the job categories and cities they follow, and the
// one-click unsubscribe link used in alert emails.

const PREFS = ['jobAlertsInApp', 'jobAlertsEmail', 'weeklyDigest', 'applicationEmails', 'scholarshipAlertsInApp', 'scholarshipAlertsEmail'];
const LABEL = { jobAlertsEmail: 'job alert emails', weeklyDigest: 'the weekly job digest', applicationEmails: 'application update emails', scholarshipAlertsEmail: 'scholarship alert emails' };

function shape(user) {
  const prefs = user.notificationPreferences || {};
  return {
    preferences: Object.fromEntries(PREFS.map((k) => [k, prefs[k] !== false])),
    jobPreferences: { categories: user.jobPreferences?.categories || [], cities: user.jobPreferences?.cities || [], remoteOk: Boolean(user.jobPreferences?.remoteOk) },
    categories: JOB_CATEGORIES
  };
}

// GET /api/notifications/settings
const getSettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('notificationPreferences jobPreferences').lean();
  return ok(res, shape(user));
});

// PUT /api/notifications/settings { preferences: {...booleans}, jobPreferences: { categories, cities, remoteOk } }
const saveSettings = asyncHandler(async (req, res) => {
  const set = {};
  const prefs = req.body?.preferences || {};
  for (const k of PREFS) if (prefs[k] !== undefined) set[`notificationPreferences.${k}`] = Boolean(prefs[k]);
  const jp = req.body?.jobPreferences;
  if (jp) {
    const categories = Array.isArray(jp.categories) ? [...new Set(jp.categories)] : [];
    if (categories.some((c) => !JOB_CATEGORIES.includes(c))) throw new AppError('Choose valid job categories.', 422);
    const cities = (Array.isArray(jp.cities) ? jp.cities : String(jp.cities || '').split(',')).map((c) => String(c).trim()).filter(Boolean).slice(0, 10).map((c) => c.slice(0, 60));
    Object.assign(set, { 'jobPreferences.categories': categories, 'jobPreferences.cities': cities, 'jobPreferences.remoteOk': Boolean(jp.remoteOk) });
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set: set }, { new: true }).select('notificationPreferences jobPreferences').lean();
  return ok(res, shape(user), 'Notification settings saved.');
});

// GET /api/notifications/unsubscribe?token=&type= — public, from an email link. Turns off that
// one kind of email and shows a plain confirmation page.
const unsubscribe = asyncHandler(async (req, res) => {
  const { token, type } = req.query;
  const page = (title, text) => res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:Segoe UI,Arial,sans-serif;background:#F4F1E8;margin:0;padding:48px 16px"><main style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:32px"><h1 style="font-family:Georgia,serif;color:#0F3D2E;font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="color:#4B5A53;line-height:1.6;margin:0">${escapeHtml(text)}</p></main></body>`);
  if (!LABEL[type] || typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return page('Link not valid', 'This unsubscribe link is incomplete. You can change all emails in your CareerZ notification settings.');
  const user = await User.findOneAndUpdate({ unsubscribeToken: token }, { $set: { [`notificationPreferences.${type}`]: false } }, { new: true }).select('_id');
  if (!user) return page('Link not valid', 'This unsubscribe link has expired. You can change all emails in your CareerZ notification settings.');
  return page('You are unsubscribed', `You will no longer receive ${LABEL[type]}. You can switch them back on any time in your CareerZ notification settings.`);
});

module.exports = { getSettings, saveSettings, unsubscribe };
