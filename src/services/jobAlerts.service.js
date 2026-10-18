const User = require('../models/User');
const JobAlert = require('../models/JobAlert');
const Resume = require('../models/Resume');
const StudentProfile = require('../models/StudentProfile');
const { notify } = require('./notification.service');

// Job Alerts (Job Marketplace 19: email alerts, dashboard notifications, weekly digest) and the
// Smart Recommendation profile match. A job reaches a person when it matches one of their saved
// alerts, or their profile: preferred categories, CV/profile skills, or (for teachers) a teaching
// job, and the place fits (remote/hybrid, a preferred city, their own city, or same country when
// they gave no city). Everyone can still browse every public job.

const TEACHING = ['teaching', 'academic_leadership'];
const norm = (s) => String(s || '').trim().toLowerCase();
const words = (s) => norm(s).split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1);

function alertMatches(job, alert) {
  if (alert.country && norm(alert.country) !== norm(job.country)) return false;
  if (alert.city && !norm(job.city).includes(norm(alert.city))) return false;
  if (alert.remoteOnly && !['remote', 'hybrid'].includes(job.workMode)) return false;
  if (alert.salaryMin && !((job.salaryMax || job.salaryMin || 0) >= alert.salaryMin)) return false;
  if (alert.governmentOnly && !job.isGovernment) return false;
  if (alert.internationalOnly && !job.visaSponsorship) return false;
  if (alert.keywords) {
    const hay = norm([job.title, job.company, job.description, ...(job.skills || [])].join(' '));
    if (!words(alert.keywords).some((w) => hay.includes(w))) return false;
  }
  return true;
}

function placeFits(job, user) {
  if (['remote', 'hybrid'].includes(job.workMode)) return true;
  const prefCities = (user.jobPreferences?.cities || []).map(norm);
  if (job.city && prefCities.includes(norm(job.city))) return true;
  if (job.city && user.city && norm(job.city) === norm(user.city)) return true;
  if (!user.city && !prefCities.length && job.country && user.country && norm(job.country) === norm(user.country)) return true;
  return false;
}

// Why this job suits this person, or '' when it does not.
function profileReason(job, user, skills) {
  if (!placeFits(job, user)) return '';
  const cats = user.jobPreferences?.categories || [];
  if (job.category && cats.includes(job.category)) return 'Matches a job category you follow';
  const jobSkills = (job.skills || []).map(norm);
  const shared = jobSkills.filter((s) => skills.has(s));
  if (shared.length) return `Matches your skills: ${shared.slice(0, 3).join(', ')}`;
  if (TEACHING.includes(job.category) && user.roles?.includes('teacher')) return 'A teaching job near you';
  return '';
}

// Everyone a job should reach: Map(userId → reason).
async function recipientsFor(job, users = null) {
  const people = users || await User.find({ status: 'active', roles: { $in: ['student', 'teacher'] }, _id: { $ne: job.postedBy } })
    .select('roles city country jobPreferences notificationPreferences emailVerified').lean();
  if (!people.length) return new Map();
  const ids = people.map((p) => p._id);
  const [alerts, resumes, profiles] = await Promise.all([
    JobAlert.find({ user: { $in: ids } }).lean(),
    Resume.find({ user: { $in: ids } }).select('user skills').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user skills').lean()
  ]);
  const skillsOf = new Map();
  for (const r of [...resumes, ...profiles]) {
    const set = skillsOf.get(String(r.user)) || new Set();
    for (const s of r.skills || []) set.add(norm(s));
    skillsOf.set(String(r.user), set);
  }
  const alertsOf = new Map();
  for (const a of alerts) alertsOf.set(String(a.user), [...(alertsOf.get(String(a.user)) || []), a]);
  const out = new Map();
  for (const p of people) {
    if (String(p._id) === String(job.postedBy)) continue;
    if ((alertsOf.get(String(p._id)) || []).some((a) => alertMatches(job, a))) { out.set(String(p._id), { user: p, reason: 'Matches one of your saved job alerts' }); continue; }
    const reason = profileReason(job, p, skillsOf.get(String(p._id)) || new Set());
    if (reason) out.set(String(p._id), { user: p, reason });
  }
  return out;
}

// Sends the alert for one newly published job. One alert per person per job (dedupeKey), in the
// app and by email, each switchable in notification settings.
async function sendForJob(job) {
  if (job.status !== 'active') return 0;
  const recipients = await recipientsFor(job);
  const place = [job.city, job.country].filter(Boolean).join(', ');
  let sent = 0;
  for (const { user, reason } of recipients.values()) {
    const n = await notify(user._id, {
      title: `New job: ${job.title} at ${job.company}`,
      body: `${place ? `${place} · ` : ''}${reason}.`,
      sentBy: job.postedBy, link: `/jobs/${job._id}`, category: 'job_alert', dedupeKey: `job:${job._id}`
    }, { email: Boolean(user.emailVerified), inAppPreference: 'jobAlertsInApp', emailPreference: 'jobAlertsEmail', ctaLabel: 'View job' }).catch((err) => { console.error('[job alerts]', err.message); return null; });
    if (n) sent += 1;
  }
  return sent;
}

module.exports = { sendForJob, recipientsFor, alertMatches, profileReason, placeFits };
