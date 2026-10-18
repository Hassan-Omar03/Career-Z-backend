const crypto = require('crypto');
const Job = require('../models/Job');
const User = require('../models/User');
const { sendEmail, noticeEmailTemplate } = require('./email.service');
const { escapeHtml } = require('./notification.service');
const { recipientsFor } = require('./jobAlerts.service');
const { absolute } = require('../utils/siteUrl');

// Weekly job digest (Job Marketplace 19). Once a week per person, an email listing the jobs
// published since their last digest that match them, sent only when there is at least one and
// only when the weekly digest is switched on. Runs hourly and picks up whoever is due.

const WEEK = 7 * 864e5;
const MAX_JOBS = 10;

async function runDigest(now = new Date()) {
  const due = await User.find({
    status: 'active', emailVerified: true, roles: { $in: ['student', 'teacher'] },
    'notificationPreferences.weeklyDigest': { $ne: false },
    $or: [{ lastDigestAt: null }, { lastDigestAt: { $lte: new Date(now - WEEK) } }]
  }).select('email roles city country jobPreferences notificationPreferences emailVerified unsubscribeToken lastDigestAt').lean();
  if (!due.length) return { emailed: 0, checked: 0 };
  const jobs = await Job.find({ status: 'active', publishedAt: { $gte: new Date(now - WEEK) } }).sort({ publishedAt: -1 }).limit(300).lean();
  const perUser = new Map();
  for (const job of jobs) {
    const matches = await recipientsFor(job, due);
    for (const [id, { reason }] of matches) {
      const user = due.find((u) => String(u._id) === id);
      if (user.lastDigestAt && job.publishedAt <= user.lastDigestAt) continue; // already in an earlier digest
      perUser.set(id, [...(perUser.get(id) || []), { job, reason }]);
    }
  }
  let emailed = 0;
  for (const user of due) {
    const list = (perUser.get(String(user._id)) || []).slice(0, MAX_JOBS);
    await User.updateOne({ _id: user._id }, { $set: { lastDigestAt: now } });
    if (!list.length) continue;
    let token = user.unsubscribeToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await User.updateOne({ _id: user._id }, { $set: { unsubscribeToken: token } }); }
    const lines = list.map(({ job }) => `• ${job.title} — ${job.company}${job.city ? `, ${job.city}` : ''}\n  ${absolute(`/jobs/${job._id}`)}`);
    const title = `${list.length} new job${list.length === 1 ? '' : 's'} for you this week`;
    const unsubscribe = absolute(`/api/notifications/unsubscribe?token=${token}&type=weeklyDigest`);
    try {
      await sendEmail({
        to: user.email, subject: title, text: `${lines.join('\n')}\n\nUnsubscribe: ${unsubscribe}`,
        html: noticeEmailTemplate({ heading: escapeHtml(title), body: escapeHtml(lines.join('\n')), ctaUrl: absolute('/jobs'), ctaLabel: 'See all jobs',
          footer: `You receive this weekly digest because it is on in your CareerZ notification settings. <a href="${unsubscribe}" style="color:#8A9490;">Unsubscribe</a>` })
      });
      emailed += 1;
    } catch (err) { console.error('[job digest]', err.message); }
  }
  return { emailed, checked: due.length };
}

let timer = null;
function startJobDigest() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => runDigest().catch((err) => console.error('[job digest]', err.message)), 60 * 60 * 1000);
}

module.exports = { runDigest, startJobDigest };
