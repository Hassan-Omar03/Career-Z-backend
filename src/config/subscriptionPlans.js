// Master spec Part 17E "11. Subscription System" — Free/Basic/Professional/Enterprise tiers.
// Pricing/limits below are sensible defaults, not final business numbers — Super Admin can
// override any of them at runtime via PATCH /api/admin/subscription-plans (Setting-backed,
// same pattern as ai_enabled_providers). null = unlimited.
//
// Student count is deliberately NOT limited by any plan — enrolling real students is the
// platform's core educational function and must never be blocked by an unpaid tier. Paid plans
// only gate staff seats (a standard SaaS seat limit) and institution-owned AI keys (a genuinely
// optional add-on — personal BYOK AI keys still work on every plan, paid or not).
const DEFAULT_PLANS = {
  free: {
    label: 'Free', monthlyPriceUSD: 0,
    maxStaff: 3,
    aiInstitutionKey: false
  },
  basic: {
    label: 'Basic', monthlyPriceUSD: 29,
    maxStaff: 15,
    aiInstitutionKey: true
  },
  professional: {
    label: 'Professional', monthlyPriceUSD: 79,
    maxStaff: 75,
    aiInstitutionKey: true
  },
  enterprise: {
    label: 'Enterprise', monthlyPriceUSD: 199,
    maxStaff: null,
    aiInstitutionKey: true
  }
};

const PLAN_KEYS = Object.keys(DEFAULT_PLANS);
const PAID_PLAN_KEYS = PLAN_KEYS.filter((k) => k !== 'free');

module.exports = { DEFAULT_PLANS, PLAN_KEYS, PAID_PLAN_KEYS };
