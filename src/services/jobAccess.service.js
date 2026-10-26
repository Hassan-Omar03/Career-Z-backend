const mongoose = require('mongoose');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const { hasStaffPermission } = require('../utils/staffRoles');

// Who may publish and manage jobs (Master 4.24 "only verified organizations", 6.8, 6.9, 5.5):
//   - a verified Employer or Agent, for their own vacancies;
//   - a verified, active Institute, for its own vacancies, by its owner or staff holding
//     'recruitment:manage'.
//   - a verified Agent for an institute, only under an active Institute–Agent agreement.
// Everyone else is refused here, on the server, whatever the dashboard shows.

const PERMISSION = 'recruitment:manage';

async function institutionFor(id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Institute not found.', 404);
  const institution = await Institution.findById(id);
  if (!institution) throw new AppError('Institute not found.', 404);
  return institution;
}

// The capacity a new job is posted in: { role, institution }.
async function publisherFor(user, institutionId, agreementId) {
  if (agreementId) {
    const { publishingAuthority } = require('./recruitment.service');
    const { agreement, institution } = await publishingAuthority(user, agreementId);
    return { role: 'education_agent', institution, agreement };
  }
  if (institutionId) {
    const institution = await institutionFor(institutionId);
    if (!hasStaffPermission(institution, user._id, PERMISSION)) throw new AppError('Only the institute owner or staff with the recruitment permission can post jobs for this institute.', 403);
    if (institution.verificationStatus !== 'approved' || institution.status !== 'active') throw new AppError('This institute must be verified and active before it can post jobs.', 403);
    return { role: String(institution.owner) === String(user._id) ? 'institution_owner' : 'institution_staff', institution };
  }
  if (await isRoleVerified(user._id, 'employer')) return { role: 'employer', institution: null };
  if (await isRoleVerified(user._id, 'education_agent')) return { role: 'education_agent', institution: null };
  throw new AppError('Only verified Employers, Agents and Institutes can post jobs. If your account is pending verification, you can post once it is approved.', 403);
}

// The person who posted the job, or the owner / authorized staff of the job's institute.
async function canManageJob(job, user) {
  if (!job) return false;
  if (String(job.postedBy?._id || job.postedBy) === String(user._id)) return true;
  // An agreement job is run by the agent; the institute confirms joining from its Agents tab.
  if (!job.institution || job.agreement) return false;
  const institution = job.institution.owner ? job.institution : await Institution.findById(job.institution?._id || job.institution).select('owner staff');
  return Boolean(institution && hasStaffPermission(institution, user._id, PERMISSION));
}

// The institute behind an agent's agreement job: it makes the offer and confirms joining, and may
// see the candidates the agent puts forward (CV, interviews), but does not run the job itself.
async function isAgreementInstitute(job, user) {
  if (!job?.agreement || !job.institution) return false;
  const institution = job.institution.owner ? job.institution : await Institution.findById(job.institution?._id || job.institution).select('owner staff');
  return Boolean(institution && hasStaffPermission(institution, user._id, PERMISSION));
}
async function canSeeCandidates(job, user) { return (await canManageJob(job, user)) || isAgreementInstitute(job, user); }

async function assertCanManageJob(job, user) {
  if (!(await canManageJob(job, user))) throw new AppError('You cannot manage this job.', 403);
}

// Institutes whose jobs this user may manage.
async function manageableInstitutionIds(user) {
  const list = await Institution.find({ $or: [{ owner: user._id }, { 'staff.user': user._id }] }).select('owner staff');
  return list.filter((i) => hasStaffPermission(i, user._id, PERMISSION)).map((i) => i._id);
}

module.exports = { publisherFor, canManageJob, assertCanManageJob, manageableInstitutionIds, isAgreementInstitute, canSeeCandidates, PERMISSION };
