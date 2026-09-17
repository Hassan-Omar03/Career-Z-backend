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
const AppError = require('../utils/AppError');
const { ROLES } = require('../config/rbac');
const CENTROIDS = require('../utils/countryCentroids');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

const INSTITUTION_FEE_COMMISSION_KEY = 'institution_fee_commission_percent';
const DEFAULT_INSTITUTION_FEE_COMMISSION = 5;
const MARKETPLACE_COMMISSION_KEY = 'marketplace_commission_percent';
const DEFAULT_MARKETPLACE_COMMISSION = 10;

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
  getFinanceSummary, getPlatformReports, getDashboard, getWorldMap,
  getInstitutionFeeCommissionRate, setInstitutionFeeCommissionRate
};
