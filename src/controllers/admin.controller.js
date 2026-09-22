const User = require('../models/User');
const Institution = require('../models/Institution');
const Fee = require('../models/Fee');
const Order = require('../models/Order');
const Payslip = require('../models/Payslip');
const Job = require('../models/Job');
const Scholarship = require('../models/Scholarship');
const Course = require('../models/Course');
const RoleRequest = require('../models/RoleRequest');
const Complaint = require('../models/Complaint');
const BlockedIp = require('../models/BlockedIp');
const Country = require('../models/Country');
const Setting = require('../models/Setting');
const FeaturedListing = require('../models/FeaturedListing');
const { DEFAULT_PLANS } = require('../config/subscriptionPlans');
const { getEffectivePlans, PLAN_CONFIG_KEY } = require('../utils/subscriptionGate');
const AppError = require('../utils/AppError');
const { ROLES } = require('../config/rbac');
const CENTROIDS = require('../utils/countryCentroids');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

const INSTITUTION_FEE_COMMISSION_KEY = 'institution_fee_commission_percent';
const DEFAULT_INSTITUTION_FEE_COMMISSION = 5;
const MARKETPLACE_COMMISSION_KEY = 'marketplace_commission_percent';
const DEFAULT_MARKETPLACE_COMMISSION = 10;
const AI_PROVIDER_CONFIG_KEY = 'ai_enabled_providers';
const AI_MODEL_CONFIG_KEY = 'ai_provider_models';
const ALL_AI_PROVIDERS = {
  text: ['openai', 'claude', 'gemini', 'deepseek'],
  image: ['openai', 'stability'],
  threed: ['meshy'],
  voice: ['elevenlabs', 'google'],
  avatar: ['heygen'],
  animation: ['runway']
};

// GET /api/admin/ai-providers — Super Admin's control over which BYOK providers users/
// institutions are even allowed to connect per AI purpose, and which model each provider
// defaults to when a caller doesn't request a specific one (spec: "provider/model management").
const getAiProviderConfig = asyncHandler(async (req, res) => {
  const [enabledSetting, modelSetting] = await Promise.all([
    Setting.findOne({ key: AI_PROVIDER_CONFIG_KEY }),
    Setting.findOne({ key: AI_MODEL_CONFIG_KEY })
  ]);
  return ok(res, {
    all: ALL_AI_PROVIDERS,
    enabled: enabledSetting ? enabledSetting.value : ALL_AI_PROVIDERS,
    models: modelSetting ? modelSetting.value : {}
  });
});

// PATCH /api/admin/ai-providers (super_admin only, enforced at route level) — `enabled` and/or
// `models` may be sent together or separately.
const setAiProviderConfig = asyncHandler(async (req, res) => {
  const { enabled, models } = req.body;
  let enabledValue;
  if (enabled !== undefined) {
    if (!enabled || typeof enabled !== 'object') throw new AppError('enabled must be an object of purpose -> provider[].', 422);
    for (const purpose of Object.keys(enabled)) {
      if (!ALL_AI_PROVIDERS[purpose]) throw new AppError(`Unknown AI purpose: ${purpose}.`, 422);
      if (!Array.isArray(enabled[purpose]) || enabled[purpose].some((p) => !ALL_AI_PROVIDERS[purpose].includes(p))) {
        throw new AppError(`enabled.${purpose} must be a subset of ${ALL_AI_PROVIDERS[purpose].join(', ')}.`, 422);
      }
    }
    const setting = await Setting.findOneAndUpdate(
      { key: AI_PROVIDER_CONFIG_KEY }, { key: AI_PROVIDER_CONFIG_KEY, value: enabled }, { new: true, upsert: true }
    );
    enabledValue = setting.value;
  }

  let modelsValue;
  if (models !== undefined) {
    if (!models || typeof models !== 'object') throw new AppError('models must be an object of purpose -> { provider: modelName }.', 422);
    const cleaned = {};
    for (const purpose of Object.keys(models)) {
      if (!ALL_AI_PROVIDERS[purpose]) throw new AppError(`Unknown AI purpose: ${purpose}.`, 422);
      const providerModels = models[purpose];
      if (!providerModels || typeof providerModels !== 'object') throw new AppError(`models.${purpose} must be an object of provider -> modelName.`, 422);
      cleaned[purpose] = {};
      for (const provider of Object.keys(providerModels)) {
        if (!ALL_AI_PROVIDERS[purpose].includes(provider)) throw new AppError(`Unknown provider "${provider}" for ${purpose}.`, 422);
        const modelName = String(providerModels[provider] || '').trim();
        if (modelName) cleaned[purpose][provider] = modelName;
      }
    }
    const setting = await Setting.findOneAndUpdate(
      { key: AI_MODEL_CONFIG_KEY }, { key: AI_MODEL_CONFIG_KEY, value: cleaned }, { new: true, upsert: true }
    );
    modelsValue = setting.value;
  }

  return ok(res, { enabled: enabledValue, models: modelsValue }, 'AI provider configuration updated.');
});

// GET /api/admin/subscription-plans — Super Admin's control over subscription plan pricing and
// limits (spec Part 17E "Subscription System"). Returns both the built-in defaults and the
// currently effective (override-merged) values so the UI can show what's customized.
const getSubscriptionPlanConfig = asyncHandler(async (req, res) => {
  const effective = await getEffectivePlans();
  return ok(res, { defaults: DEFAULT_PLANS, effective });
});

// PATCH /api/admin/subscription-plans (super_admin only, enforced at route level) — body is a
// partial override map, e.g. { basic: { monthlyPriceUSD: 35 } }. Only known plan keys and known
// fields on each plan are accepted; unspecified fields keep the built-in default.
const setSubscriptionPlanConfig = asyncHandler(async (req, res) => {
  const { overrides } = req.body;
  if (!overrides || typeof overrides !== 'object') throw new AppError('overrides must be an object of plan -> {field: value}.', 422);
  const cleaned = {};
  for (const planKey of Object.keys(overrides)) {
    if (!DEFAULT_PLANS[planKey]) throw new AppError(`Unknown plan: ${planKey}.`, 422);
    const fields = overrides[planKey];
    if (!fields || typeof fields !== 'object') throw new AppError(`overrides.${planKey} must be an object.`, 422);
    cleaned[planKey] = {};
    for (const field of Object.keys(fields)) {
      if (!(field in DEFAULT_PLANS[planKey])) throw new AppError(`Unknown field "${field}" for plan ${planKey}.`, 422);
      cleaned[planKey][field] = fields[field];
    }
  }
  const setting = await Setting.findOneAndUpdate(
    { key: PLAN_CONFIG_KEY },
    { key: PLAN_CONFIG_KEY, value: cleaned },
    { new: true, upsert: true }
  );
  const merged = {};
  for (const key of Object.keys(DEFAULT_PLANS)) merged[key] = { ...DEFAULT_PLANS[key], ...(setting.value[key] || {}) };
  return ok(res, merged, 'Subscription plan configuration updated.');
});

// GET /api/admin/institution-fee-commission-rate
const getInstitutionFeeCommissionRate = asyncHandler(async (req, res) => {
  const setting = await Setting.findOne({ key: INSTITUTION_FEE_COMMISSION_KEY });
  return ok(res, { rate: setting ? setting.value : DEFAULT_INSTITUTION_FEE_COMMISSION });
});

// PATCH /api/admin/institution-fee-commission-rate (super_admin only, enforced at route level)
const setInstitutionFeeCommissionRate = asyncHandler(async (req, res) => {
  const { rate } = req.body;
  if (typeof rate !== 'number' || rate < 0 || rate > 100) throw new AppError('rate must be a number between 0 and 100.', 422);
  const setting = await Setting.findOneAndUpdate(
    { key: INSTITUTION_FEE_COMMISSION_KEY },
    { key: INSTITUTION_FEE_COMMISSION_KEY, value: rate },
    { new: true, upsert: true }
  );
  return ok(res, { rate: setting.value }, 'Institution fee commission rate updated.');
});

// GET /api/admin/finance — real platform revenue, computed from actual paid fees / completed
// orders / active featured-job purchases at the currently configured rate (same honest,
// no-payment-gateway-yet pattern as Marketplace's own computeEarnings).
const getFinanceSummary = asyncHandler(async (req, res) => {
  const [feeAgg, orderAgg, payrollAgg, feeRateSetting, marketplaceRateSetting, featuredAgg] = await Promise.all([
    Fee.aggregate([{ $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Order.aggregate([{ $group: { _id: '$status', total: { $sum: '$totalPrice' }, count: { $sum: 1 } } }]),
    Payslip.aggregate([{ $group: { _id: '$status', total: { $sum: '$netAmount' }, count: { $sum: 1 } } }]),
    Setting.findOne({ key: INSTITUTION_FEE_COMMISSION_KEY }),
    Setting.findOne({ key: MARKETPLACE_COMMISSION_KEY }),
    FeaturedListing.aggregate([{ $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }])
  ]);

  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, { total: r.total, count: r.count }]));
  const feeMap = toMap(feeAgg);
  const orderMap = toMap(orderAgg);

  const feeCommissionRate = feeRateSetting ? feeRateSetting.value : DEFAULT_INSTITUTION_FEE_COMMISSION;
  const marketplaceCommissionRate = marketplaceRateSetting ? marketplaceRateSetting.value : DEFAULT_MARKETPLACE_COMMISSION;

  const paidFeesTotal = feeMap.paid?.total || 0;
  const deliveredOrdersTotal = (orderMap.delivered?.total || 0) + (orderMap.completed?.total || 0);
  const featuredJobRevenue = featuredAgg[0]?.total || 0;

  const institutionFeeCommission = Math.round(paidFeesTotal * (feeCommissionRate / 100) * 100) / 100;
  const marketplaceCommissionEarned = Math.round(deliveredOrdersTotal * (marketplaceCommissionRate / 100) * 100) / 100;
  const totalPlatformRevenue = Math.round((institutionFeeCommission + marketplaceCommissionEarned + featuredJobRevenue) * 100) / 100;

  return ok(res, {
    fees: feeMap,
    marketplaceOrders: orderMap,
    payroll: toMap(payrollAgg),
    platformRevenue: {
      institutionFeeCommission: { amount: institutionFeeCommission, rate: feeCommissionRate, basedOn: paidFeesTotal },
      marketplaceCommission: { amount: marketplaceCommissionEarned, rate: marketplaceCommissionRate, basedOn: deliveredOrdersTotal },
      featuredJobRevenue: { amount: featuredJobRevenue, count: featuredAgg[0]?.count || 0 },
      total: totalPlatformRevenue,
      note: 'No payment gateway is connected yet, so these are computed ledger amounts (real formulas on real records), not confirmed bank transfers.'
    }
  });
});

// GET /api/admin/reports
const getPlatformReports = asyncHandler(async (req, res) => {
  const [
    totalUsers, usersByRole, totalInstitutions, institutionsByStatus,
    totalCourses, totalJobs, openJobs, totalScholarships, openScholarships
  ] = await Promise.all([
    User.countDocuments(),
    User.aggregate([{ $unwind: '$roles' }, { $group: { _id: '$roles', count: { $sum: 1 } } }]),
    Institution.countDocuments(),
    Institution.aggregate([{ $group: { _id: '$verificationStatus', count: { $sum: 1 } } }]),
    Course.countDocuments(),
    Job.countDocuments(),
    Job.countDocuments({ status: 'active' }),
    Scholarship.countDocuments(),
    Scholarship.countDocuments({ status: 'open' })
  ]);

  return ok(res, {
    totalUsers,
    usersByRole: Object.fromEntries(usersByRole.map((r) => [r._id, r.count])),
    totalInstitutions,
    institutionsByStatus: Object.fromEntries(institutionsByStatus.map((r) => [r._id, r.count])),
    totalCourses,
    totalJobs,
    openJobs,
    totalScholarships,
    openScholarships
  });
});

// GET /api/admin/dashboard — the Super Admin home page's single aggregation call: platform-wide
// stats across every account type (spec Part 16A "Live Dashboard"), today's activity, revenue
// snapshot, and pending-work counters. No field here is hardcoded — every number is a real
// query result, and roles with zero users still show up as 0 (never silently omitted).
const getDashboard = asyncHandler(async (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const [
    totalUsers, usersByRoleAgg,
    totalInstitutions, institutionsByStatusAgg,
    newUsersToday, newInstitutionsToday,
    pendingRoleRequests, pendingInstitutions, openComplaints, blockedIpCount,
    feePaidAgg, orderDeliveredAgg,
    totalCourses, totalJobs, activeJobs, totalScholarships, openScholarships
  ] = await Promise.all([
    User.countDocuments(),
    User.aggregate([{ $unwind: '$roles' }, { $group: { _id: '$roles', count: { $sum: 1 } } }]),
    Institution.countDocuments(),
    Institution.aggregate([{ $group: { _id: '$verificationStatus', count: { $sum: 1 } } }]),
    User.countDocuments({ createdAt: { $gte: startOfDay } }),
    Institution.countDocuments({ createdAt: { $gte: startOfDay } }),
    RoleRequest.countDocuments({ status: 'pending' }),
    Institution.countDocuments({ verificationStatus: 'pending' }),
    Complaint.countDocuments({ status: { $in: ['open', 'in_review'] } }),
    BlockedIp.countDocuments(),
    Fee.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$currency', total: { $sum: '$amount' } } }]),
    Order.aggregate([{ $match: { status: 'delivered' } }, { $group: { _id: '$currency', total: { $sum: '$totalPrice' } } }]),
    Course.countDocuments(),
    Job.countDocuments(),
    Job.countDocuments({ status: 'active' }),
    Scholarship.countDocuments(),
    Scholarship.countDocuments({ status: 'open' })
  ]);

  const usersByRole = Object.fromEntries(ROLES.map((r) => [r, 0]));
  usersByRoleAgg.forEach((r) => { usersByRole[r._id] = r.count; });

  return ok(res, {
    totalUsers,
    usersByRole,
    newUsersToday,
    totalInstitutions,
    institutionsByStatus: Object.fromEntries(institutionsByStatusAgg.map((r) => [r._id, r.count])),
    newInstitutionsToday,
    pendingWork: { roleRequests: pendingRoleRequests, institutionVerifications: pendingInstitutions, openComplaints, blockedIps: blockedIpCount },
    revenue: { feesCollected: feePaidAgg, marketplaceDelivered: orderDeliveredAgg },
    platform: { totalCourses, totalJobs, activeJobs, totalScholarships, openScholarships }
  });
});

// POST /api/admin/ai-insights — real BYOK AI predictions/analysis over real platform-wide
// aggregates (spec: "AI Insights & Predictions"). CareerZ never pays for or supplies the AI — the
// Super Admin connects their own key (Profile -> AI Settings) exactly like every other AI
// assistant in the platform, and the model only ever sees real computed numbers, never invents any.
const getAiInsights = asyncHandler(async (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers, newUsersToday, newUsersLast30,
    totalInstitutions, pendingInstitutions,
    pendingRoleRequests, openComplaints, blockedIpCount,
    feePaidAgg, feePendingAgg, feeOverdueAgg,
    activeJobs, openScholarships
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: startOfDay } }),
    User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Institution.countDocuments(),
    Institution.countDocuments({ verificationStatus: 'pending' }),
    RoleRequest.countDocuments({ status: 'pending' }),
    Complaint.countDocuments({ status: { $in: ['open', 'in_review'] } }),
    BlockedIp.countDocuments(),
    Fee.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Fee.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Fee.aggregate([{ $match: { status: 'overdue' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Job.countDocuments({ status: 'active' }),
    Scholarship.countDocuments({ status: 'open' })
  ]);

  const dataSummary = `Total users: ${totalUsers} (${newUsersToday} today, ${newUsersLast30} in last 30 days)
Institutions: ${totalInstitutions} total, ${pendingInstitutions} pending verification
Pending role requests: ${pendingRoleRequests}
Open complaints: ${openComplaints}
Blocked IPs: ${blockedIpCount}
Fees — paid: ${feePaidAgg[0]?.total || 0}, pending: ${feePendingAgg[0]?.total || 0}, overdue: ${feeOverdueAgg[0]?.total || 0}
Active job postings: ${activeJobs}
Open scholarships: ${openScholarships}`;

  const aiService = require('../services/ai.service');
  try {
    const result = await aiService.generate(
      req.user._id,
      'You are a platform operations analyst for an education/careers platform (CareerZ). Given real, structured platform-wide metrics, write a short (5-8 bullet points) analysis: growth trend, verification/support backlog risk, fee-collection health, and 1-2 concrete recommended actions. Be specific to the numbers given, never invent numbers not provided. All decisions remain the Super Admin\'s own — you are only summarizing/predicting trends, not deciding.',
      dataSummary
    );
    return ok(res, { insights: result, dataSummary });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// GET /api/admin/world-map — real per-country user + institution counts (spec Part 16A.3
// "Interactive World Map"). Positions are approximate geographic centroids (see
// utils/countryCentroids.js), not traced borders — but every count is a real DB aggregate.
const getWorldMap = asyncHandler(async (req, res) => {
  const [usersByCountryAgg, institutionsByCountryAgg, countries] = await Promise.all([
    User.aggregate([{ $match: { country: { $ne: null } } }, { $group: { _id: '$country', count: { $sum: 1 } } }]),
    Institution.aggregate([{ $group: { _id: '$country', count: { $sum: 1 } } }]),
    Country.find().select('code name')
  ]);

  const nameByCode = Object.fromEntries(countries.map((c) => [c.code, c.name]));
  const userMap = Object.fromEntries(usersByCountryAgg.map((r) => [r._id, r.count]));
  const instMap = Object.fromEntries(institutionsByCountryAgg.map((r) => [r._id, r.count]));

  const codes = new Set([...Object.keys(userMap), ...Object.keys(instMap)]);
  const points = Array.from(codes)
    .filter((code) => CENTROIDS[code]) // only plot codes we have a real centroid for
    .map((code) => ({
      code,
      name: nameByCode[code] || code,
      lat: CENTROIDS[code][0],
      lng: CENTROIDS[code][1],
      userCount: userMap[code] || 0,
      institutionCount: instMap[code] || 0
    }))
    .sort((a, b) => (b.userCount + b.institutionCount) - (a.userCount + a.institutionCount));

  const unplottedCodes = Array.from(codes).filter((code) => !CENTROIDS[code]);

  return ok(res, { points, unplottedCodes });
});

module.exports = {
  getFinanceSummary, getPlatformReports, getDashboard, getWorldMap, getAiInsights,
  getInstitutionFeeCommissionRate, setInstitutionFeeCommissionRate,
  getAiProviderConfig, setAiProviderConfig,
  getSubscriptionPlanConfig, setSubscriptionPlanConfig
};
