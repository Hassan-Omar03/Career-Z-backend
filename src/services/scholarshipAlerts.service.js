const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const { notify } = require('./notification.service');

// Scholarship alerts (Master 35 Notification Center: "Scholarship Updates"). When an open
// scholarship is published, the people it is for hear about it once: students, and teachers
// when the publisher included them, in the scholarship's country (or anywhere when it has none).
// A student whose program or skills appear in the eligibility text is told so.

const norm = (s) => String(s || '').trim().toLowerCase();

async function sendForScholarship(scholarship) {
  if (scholarship.status !== 'open') return 0;
  if (scholarship.applicationDeadline && new Date(scholarship.applicationDeadline) < new Date()) return 0;
  const roles = (scholarship.audience?.length ? scholarship.audience : ['students']).map((a) => (a === 'teachers' ? 'teacher' : 'student'));
  const people = await User.find({ status: 'active', roles: { $in: roles }, _id: { $ne: scholarship.donor } }).select('country emailVerified').lean();
  const country = norm(scholarship.country);
  const eligible = people.filter((p) => !country || norm(p.country) === country);
  const profiles = await StudentProfile.find({ user: { $in: eligible.map((p) => p._id) } }).select('user program skills').lean();
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  const criteria = norm(`${scholarship.title} ${scholarship.eligibilityCriteria} ${scholarship.description}`);
  let sent = 0;
  for (const p of eligible) {
    const prof = byUser.get(String(p._id));
    const hit = [prof?.program, ...(prof?.skills || [])].map(norm).find((w) => w.length > 2 && criteria.includes(w));
    const n = await notify(p._id, {
      title: `New scholarship: ${scholarship.title}`,
      body: `${scholarship.currency} ${Number(scholarship.amount || 0).toLocaleString()}${scholarship.applicationDeadline ? ` · apply by ${new Date(scholarship.applicationDeadline).toDateString()}` : ''}${hit ? ` · mentions ${hit}` : ''}.`,
      sentBy: scholarship.donor, link: `/scholarships/${scholarship._id}`, category: 'scholarship_alert', dedupeKey: `scholarship:${scholarship._id}`
    }, { email: Boolean(p.emailVerified), inAppPreference: 'scholarshipAlertsInApp', emailPreference: 'scholarshipAlertsEmail', ctaLabel: 'View scholarship' }).catch(() => null);
    if (n) sent += 1;
  }
  return sent;
}

// Runs once per scholarship, when it is first published.
async function onScholarshipPublished(scholarship) {
  if (scholarship.publishedAt) return;
  scholarship.publishedAt = new Date();
  await scholarship.save();
  const run = sendForScholarship(scholarship).catch((err) => console.error('[scholarship alerts]', err.message));
  if (process.env.NODE_ENV === 'test') await run;
}

module.exports = { sendForScholarship, onScholarshipPublished };
