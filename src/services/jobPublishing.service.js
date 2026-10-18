const moderation = require('./jobModeration.service');
const { notify, notifyAdmins } = require('./notification.service');

// Draft → Submit → Validation/Risk check → Admin review when needed → Published (Master 12.5).
// `submit` runs the risk scan and either publishes the job or holds it for an admin. Anything
// that should happen when a job goes live (job alerts, matching notifications) hangs off
// `onPublished`, which runs exactly once per job, at the moment it first becomes active.

async function submit(job, publisher, role) {
  const result = await moderation.assess(job, publisher, role);
  job.moderation = { ...(job.moderation?.toObject?.() || job.moderation || {}), riskScore: result.score, flags: result.flags, submittedAt: new Date(), reviewedBy: null, reviewedAt: null, note: '' };
  if (result.hold) {
    job.status = 'pending_review';
    await job.save();
    await notifyAdmins({ title: `Job waiting for review: ${job.title}`, body: `${job.company} · ${result.flags.map((f) => f.label).join('; ')}` }).catch(() => {});
    return { published: false, flags: result.flags };
  }
  job.status = 'active';
  await job.save();
  await onPublished(job);
  return { published: true, flags: result.flags };
}

// Runs once, when a job first goes live (direct publish or admin approval).
async function onPublished(job) {
  if (job.publishedAt) return;
  job.publishedAt = new Date();
  await job.save();
  // Job alerts (saved alerts + profile match, in the app and by email). Awaited in tests; in
  // production it runs after the response so a large audience never slows publishing down.
  const run = require('./jobAlerts.service').sendForJob(job).catch((err) => console.error('[job alerts]', err.message));
  if (process.env.NODE_ENV === 'test') await run;
}

// Admin decision on a held job.
async function review(job, admin, decision, note = '') {
  job.moderation.reviewedBy = admin._id;
  job.moderation.reviewedAt = new Date();
  job.moderation.note = String(note || '').slice(0, 1000);
  if (decision === 'approve') {
    job.status = 'active';
    await job.save();
    await onPublished(job);
    await notify(job.postedBy, { title: `Job approved: ${job.title}`, body: 'Your job is now live on CareerZ.', sentBy: admin._id }).catch(() => {});
  } else {
    job.status = 'rejected';
    await job.save();
    await notify(job.postedBy, { title: `Job not approved: ${job.title}`, body: job.moderation.note || 'An admin did not approve this job. Edit it and submit again.', sentBy: admin._id }).catch(() => {});
  }
  return job;
}

module.exports = { submit, onPublished, review };
