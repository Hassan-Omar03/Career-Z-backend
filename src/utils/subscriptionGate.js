const Setting = require('../models/Setting');
const AppError = require('./AppError');
const { DEFAULT_PLANS } = require('../config/subscriptionPlans');

const PLAN_CONFIG_KEY = 'subscription_plan_config';

// Merges Super-Admin overrides (partial, per-plan) on top of the built-in defaults, so an admin
// only has to specify the fields they're changing (e.g. just a new price) via Setting.
async function getEffectivePlans() {
  const setting = await Setting.findOne({ key: PLAN_CONFIG_KEY });
  if (!setting || !setting.value) return DEFAULT_PLANS;
  const merged = {};
  for (const key of Object.keys(DEFAULT_PLANS)) merged[key] = { ...DEFAULT_PLANS[key], ...(setting.value[key] || {}) };
  return merged;
}

// A paid plan that has lapsed (past currentPeriodEnd, or manually marked expired) silently
// behaves like Free rather than blocking the institution outright — features just fall back to
// Free-tier limits until they renew.
function isPlanActive(institution) {
  const sub = institution.subscription;
  if (!sub || sub.plan === 'free') return true;
  if (sub.status !== 'active') return false;
  if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < new Date()) return false;
  return true;
}

function effectivePlanKey(institution) {
  return isPlanActive(institution) ? (institution.subscription?.plan || 'free') : 'free';
}

async function getEffectivePlanFor(institution) {
  const plans = await getEffectivePlans();
  return plans[effectivePlanKey(institution)];
}

async function assertStudentCapAllows(institution, currentCount) {
  const plan = await getEffectivePlanFor(institution);
  if (plan.maxStudents != null && currentCount >= plan.maxStudents) {
    throw new AppError(
      `Student limit reached for the ${plan.label} plan (${plan.maxStudents} students). Upgrade the institution's subscription to admit more students.`,
      403
    );
  }
}

async function assertAiInstitutionKeyAllowed(institution) {
  const plan = await getEffectivePlanFor(institution);
  if (!plan.aiInstitutionKey) {
    throw new AppError(`Institution-level AI keys require the Basic plan or higher. Current plan: ${plan.label}.`, 403);
  }
}

module.exports = {
  PLAN_CONFIG_KEY, getEffectivePlans, getEffectivePlanFor, isPlanActive, effectivePlanKey,
  assertStudentCapAllows, assertAiInstitutionKeyAllowed
};
