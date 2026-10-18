const Job = require('../models/Job');
const RoleRequest = require('../models/RoleRequest');

// Master 12.5 Job Approval System (Submit → Auto Check → Risk Scan → Publish, with Admin Review
// when needed) and 4.31 Fraud Detection ("Fake Jobs", "Risk Scoring"). Each rule that matches
// adds a flag with points; a job reaching HOLD_AT points, or with any rule marked `hold`, waits
// for an admin instead of going live. The rules look only at the job and its publisher.

const HOLD_AT = 40;
const MONEY_WORDS = /(registration|processing|security|training|medical|visa|application)\s*(fee|charges?|deposit)|pay(ment)?\s+(of|rs\.?|pkr|\$)|send\s+(money|payment|rs|pkr)|advance\s+(payment|fee)|refundable\s+deposit|easypaisa|jazz\s*cash\s*(number|account)|western\s+union/i;
const OFF_PLATFORM_ONLY = /(whats\s*app|wa\.me|telegram|call\s+(now|on)|contact\s+on)\s*[:\-]?\s*\+?\d[\d\s\-]{8,}/i;
const TOO_GOOD = /(guaranteed|100%)\s+(job|visa|selection|placement)|no\s+(interview|experience)\s+(needed|required).{0,40}(lakh|\$\s*\d{4,})|earn\s+\d+\s*(k|lakh|000)\s*(per|a)\s*(day|week)/i;

function rules({ job, publisher, roleRequest, duplicateCount }) {
  const text = `${job.title || ''}\n${job.description || ''}`;
  const out = [];
  const add = (code, label, points, hold = false) => out.push({ code, label, points, hold });
  if (MONEY_WORDS.test(text)) add('asks_for_money', 'Asks applicants to pay a fee or send money', 60, true);
  if (OFF_PLATFORM_ONLY.test(text)) add('off_platform_contact', 'Pushes applicants to a phone or WhatsApp number', 25);
  if (TOO_GOOD.test(text)) add('too_good_to_be_true', 'Guaranteed job/visa or unrealistic earnings', 40, true);
  const min = Number(job.salaryMin) || 0, max = Number(job.salaryMax) || 0;
  if (min && max && max > min * 10) add('salary_range', 'Salary range is unusually wide', 20);
  if (min && max && max < min) add('salary_invalid', 'Maximum salary is lower than minimum', 20);
  if (String(job.description || '').trim().length < 40) add('thin_description', 'Very short job description', 15);
  if (duplicateCount > 0) add('duplicate', 'The same publisher already has an open job with this title', 30, true);
  if (job.visaSponsorship && publisher?.roles?.includes('education_agent') && roleRequest?.subtype !== 'agency') add('visa_unlicensed', 'Visa job from an agent not registered as an agency', 40, true);
  if (job.visaSponsorship && publisher?.roles?.includes('employer') && !job.institution && roleRequest?.subtype !== 'recruitment_agency') add('visa_unlicensed', 'Visa job from an employer not registered as a recruitment agency', 40, true);
  if (roleRequest?.subtype === 'startup') add('startup_employer', 'Startup employer without company documents yet', 25, true);
  const approvedAt = roleRequest?.approvedAt || roleRequest?.reviewedAt;
  if (!job.institution && approvedAt && Date.now() - new Date(approvedAt).getTime() < 7 * 864e5) add('new_publisher', 'Publisher was approved less than 7 days ago', 15);
  return out;
}

// Scores a job about to be published. The publisher role is the one the job is posted under.
async function assess(job, publisher, role) {
  const [roleRequest, duplicateCount] = await Promise.all([
    role ? RoleRequest.findOne({ user: publisher._id, requestedRole: role, status: 'approved' }).sort({ createdAt: -1 }).lean() : null,
    Job.countDocuments({ _id: { $ne: job._id }, postedBy: job.postedBy, title: new RegExp(`^${String(job.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: { $in: ['active', 'pending_review'] } })
  ]);
  const flags = rules({ job, publisher, roleRequest, duplicateCount });
  const score = flags.reduce((n, f) => n + f.points, 0);
  const hold = score >= HOLD_AT || flags.some((f) => f.hold);
  return { score, flags: flags.map(({ code, label, points }) => ({ code, label, points })), hold };
}

module.exports = { assess, HOLD_AT };
