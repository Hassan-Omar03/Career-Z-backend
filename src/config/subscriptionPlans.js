// Master spec Part 17E "11. Subscription System" — Free/Basic/Professional/Enterprise tiers.
// Pricing/limits below are sensible defaults, not final business numbers — Super Admin can
// override any of them at runtime via PATCH /api/admin/subscription-plans (Setting-backed,
// same pattern as ai_enabled_providers). null = unlimited.
const DEFAULT_PLANS = {
  free: {
    label: 'Free', monthlyPriceUSD: 0,
    maxStudents: 50, maxStaff: 3,
    aiInstitutionKey: false, opsModules: false
  },
  basic: {
    label: 'Basic', monthlyPriceUSD: 29,
    maxStudents: 300, maxStaff: 15,
    aiInstitutionKey: true, opsModules: true
  },
  professional: {
    label: 'Professional', monthlyPriceUSD: 79,
    maxStudents: 1500, maxStaff: 75,
    aiInstitutionKey: true, opsModules: true
  },
  enterprise: {
    label: 'Enterprise', monthlyPriceUSD: 199,
    maxStudents: null, maxStaff: null,
    aiInstitutionKey: true, opsModules: true
  }
};

const PLAN_KEYS = Object.keys(DEFAULT_PLANS);
const PAID_PLAN_KEYS = PLAN_KEYS.filter((k) => k !== 'free');

module.exports = { DEFAULT_PLANS, PLAN_KEYS, PAID_PLAN_KEYS };
