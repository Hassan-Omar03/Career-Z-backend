const GuestApplication = require('../models/GuestApplication');
const JobApplication = require('../models/JobApplication');
const PrivateFile = require('../models/PrivateFile');
const Commission = require('../models/Commission');
const { notify } = require('./notification.service');

// A guest who later creates a CareerZ account with the same (verified) email gets their guest
// applications moved into the account: same job, stage, history, CV and joining status. From then
// on they continue like any applicant (offer, offer letter, messages, joining).
async function claimFor(user) {
  if (!user?.emailVerified || !user.email) return 0;
  const guests = await GuestApplication.find({ email: String(user.email).toLowerCase(), emailVerified: true, status: { $ne: 'withdrawn' } }).populate('job', 'title company');
  let moved = 0;
  for (const g of guests) {
    if (!g.job) continue;
    if (!(await JobApplication.exists({ job: g.job._id, applicant: user._id }))) {
      const app = await JobApplication.create({
        job: g.job._id, applicant: user._id, coverLetter: g.coverLetter, status: g.status, joining: g.joining,
        resumeSnapshot: { cvFile: g.cv, cvFileName: 'CV', cvSource: 'file' },
        statusHistory: [...g.statusHistory.map((h) => h.toObject()), { status: g.status, byRole: 'applicant', note: 'Moved from the guest application to the CareerZ account' }]
      });
      await PrivateFile.updateOne({ _id: g.cv }, { $set: { owner: user._id } });
      await Commission.updateMany({ guestApplication: g._id }, { $set: { application: app._id, candidate: user._id }, $unset: { guestApplication: 1 } });
      moved += 1;
      await notify(user._id, { title: `Your application for ${g.job.title} is now in your account`, body: 'Follow it in Jobs & Applications → My Applications.', link: require('../utils/dashLinks').candidate('applications'), category: 'application' }).catch(() => {});
    }
    await g.deleteOne();
  }
  return moved;
}

module.exports = { claimFor };
