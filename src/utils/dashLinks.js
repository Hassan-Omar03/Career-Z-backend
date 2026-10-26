// Deep links into the dashboard for notifications, so a click opens the exact place:
//   ?ws=<workspace>&tab=<sidebar tab>&sub=<inner tab>. The dashboard picks the right workspace.

const candidate = (sub = 'applications') => `/dashboard?tab=jobs&sub=${sub}`;

// The people who manage a job: an institute's own job opens Jobs & Hiring; an employer's or an
// agent's job opens their jobs list.
function manager(job) {
  if (job?.institution && !job?.agreement) return '/dashboard?ws=institution&tab=jobsHiring';
  return '/dashboard?tab=jobs';
}

const institutionAgents = '/dashboard?ws=institution&tab=jobsHiring&sub=agents';
const agentRequests = '/dashboard?ws=education_agent&tab=instituteRequests';
const agentCommission = '/dashboard?ws=education_agent&tab=commission';
const agentScholarships = '/dashboard?ws=education_agent&tab=agentScholarships';
const donorScholarships = '/dashboard?ws=donor&tab=scholarships';
const teacherHome = '/dashboard?ws=teacher&tab=summary';

module.exports = { candidate, manager, institutionAgents, agentRequests, agentCommission, agentScholarships, donorScholarships, teacherHome };
