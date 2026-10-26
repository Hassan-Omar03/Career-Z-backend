const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const SubscriptionPurchase = require('../models/SubscriptionPurchase');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { PAID_PLAN_KEYS } = require('../config/subscriptionPlans');
const { getEffectivePlans, effectivePlanKey } = require('../utils/subscriptionGate');

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  if (isOwner) return;
  const entry = institution.staff.find((s) => s.user.toString() === userId.toString());
  if (!entry) throw new AppError('You are not staff at this institution.', 403);
}

// GET /api/subscriptions/plans — public plan catalogue (Free + any Super-Admin pricing/limit overrides).
const getPlans = asyncHandler(async (req, res) => {
  const plans = await getEffectivePlans();
  return ok(res, plans);
});

// GET /api/subscriptions/institutions/:id — current plan, status and live usage vs. limits.
const getInstitutionSubscription = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const plans = await getEffectivePlans();
  const activePlanKey = effectivePlanKey(institution);
  const [studentCount, staffCount] = await Promise.all([
    StudentProfile.countDocuments({ primaryInstitution: institution._id }),
    Promise.resolve(institution.staff.length)
  ]);

  return ok(res, {
    subscription: institution.subscription,
    activePlan: activePlanKey,
    planDetails: plans[activePlanKey],
    usage: { students: studentCount, staff: staffCount },
    allPlans: plans
  });
});

// POST /api/subscriptions/institutions/:id/checkout — starts a JazzCash checkout for one 30-day
// period of the chosen plan (renewed by paying again). Same pending-record pattern as Featured
// Job / Course checkout: nothing on the institution changes until JazzCash confirms payment.
const createSubscriptionCheckout = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (institution.owner.toString() !== req.user._id.toString()) {
    throw new AppError('Only the institution owner can change its subscription plan.', 403);
  }

  const { plan } = req.body;
  if (!PAID_PLAN_KEYS.includes(plan)) throw new AppError(`plan must be one of: ${PAID_PLAN_KEYS.join(', ')}.`, 422);

  const plans = await getEffectivePlans();
  const amount = plans[plan].monthlyPriceUSD;
  if (!(amount > 0)) throw new AppError('This plan has no configured price yet — ask the Super Admin to set one.', 503);

  // Confirmation arrives through JazzCash's return/IPN or /api/payments/jazzcash/:txnRefNo/sync.
  const { startCheckout } = require('./jazzcash.controller');
  return startCheckout(req, res, {
    kind: 'subscription', amount, currency: 'USD', description: `CareerZ ${plans[plan].label} plan 30 days`,
    createRefs: async () => ({ subscriptionPurchase: (await SubscriptionPurchase.create({
      institution: institution._id, plan, purchasedBy: req.user._id,
      amount, currency: 'USD', paymentMethod: req.body?.gateway === 'safepay' ? 'safepay' : 'jazzcash', status: 'pending'
    }))._id })
  });
});

module.exports = { getPlans, getInstitutionSubscription, createSubscriptionCheckout };
