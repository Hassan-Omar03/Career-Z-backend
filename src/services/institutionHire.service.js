const Institution = require('../models/Institution');
const Employment = require('../models/Employment');
const TeacherEmployment = require('../models/TeacherEmployment');
const { onboardStaff } = require('../utils/staffOnboarding');
const { notify } = require('./notification.service');

// The one way an institute hires: Jobs & Hiring. When joining is confirmed on an institute's job,
// the person becomes the institute's staff on the spot (a teacher for teaching jobs), with the
// salary from the accepted offer. No second offer to accept.
async function onInstituteJoining(application) {
  const job = application.job;
  if (!job?.institution || !application.applicant) return null;
  const applicantId = application.applicant._id || application.applicant;
  const institution = await Institution.findById(job.institution);
  if (!institution) return null;
  if (institution.staff.some((s) => String(s.user) === String(applicantId))) return null;
  const role = job.category === 'teaching' ? 'teacher' : 'staff';
  await onboardStaff(institution, applicantId, { role, designation: job.title, department: '' });
  if (role === 'teacher') {
    const offer = await Employment.findOne({ application: application._id }).lean();
    const monthly = offer?.salary ? (offer.offer?.salaryPeriod === 'year' ? Math.round(offer.salary / 12) : offer.salary) : (job.salaryMin || 0);
    await TeacherEmployment.create({
      teacher: applicantId, institution: institution._id, role, designation: job.title, contractTerms: offer?.offer?.terms || '',
      salaryType: 'monthly', monthlySalary: monthly || 0, salaryCurrency: offer?.currency || job.currency || 'PKR',
      status: 'active', offeredBy: job.postedBy, respondedAt: new Date(), startedAt: offer?.startDate || new Date()
    }).catch((e) => { if (e.code !== 11000) throw e; });
  }
  await notify(applicantId, { title: `Welcome to ${institution.name}`, body: `You are now ${role === 'teacher' ? 'a teacher' : 'staff'} at ${institution.name} (${job.title}). Open your dashboard to see it.`, link: role === 'teacher' ? require('../utils/dashLinks').teacherHome : '/dashboard', category: 'application' }, { email: true }).catch(() => {});
  return role;
}

module.exports = { onInstituteJoining };
