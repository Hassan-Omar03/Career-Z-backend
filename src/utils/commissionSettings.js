// Every rate CareerZ uses to take a share of a payment, in one list. Each is a Super Admin
// setting; until the Super Admin sets one it is 0 — nothing is hardcoded.
const SERVICES = [
  { id: 'fee', key: 'institution_fee_commission_percent', label: 'School / institute fees', about: 'Taken from each fee paid online; the rest goes to the institute wallet.' },
  { id: 'course', key: 'course_commission_percent', label: 'Course sales', about: 'Taken from each paid course; the rest goes to the institute (or the teacher).' },
  { id: 'tutoring', key: 'tutoring_commission_percent', label: 'Tutoring fees', about: 'Taken from each tuition fee paid to an independent tutor.' },
  { id: 'marketplace', key: 'marketplace_commission_percent', label: 'Marketplace sales', about: 'Taken from each delivered and paid order; per-category rates override it.' },
  { id: 'recruitment', key: 'recruitment_platform_fee_percent', label: 'Agent recruitment fees', about: 'Taken from each fee an institute pays an agent under an agreement.' },
  { id: 'donation', key: 'donation_commission_percent', label: 'Donations', about: 'Taken from each donation.' },
  { id: 'agentHire', key: 'commission_rate_percent', label: "Agent's own hiring commission", about: "The agent's earning on a hire for the agent's own job (% of the salary). This is the agent's, not CareerZ's." }
];

const asRate = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
};

async function rateFor(key, session = null) {
  const Setting = require('../models/Setting');
  const query = Setting.findOne({ key });
  if (session) query.session(session);
  const s = await query;
  return s ? asRate(s.value) : 0;
}

module.exports = { SERVICES, asRate, rateFor };
