const User = require('../models/User');
const Institution = require('../models/Institution');
const Fee = require('../models/Fee');
const Order = require('../models/Order');
const Payslip = require('../models/Payslip');
const Job = require('../models/Job');
const Scholarship = require('../models/Scholarship');
const Course = require('../models/Course');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// GET /api/admin/finance
const getFinanceSummary = asyncHandler(async (req, res) => {
  const [feeAgg, orderAgg, payrollAgg] = await Promise.all([
    Fee.aggregate([{ $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Order.aggregate([{ $group: { _id: '$status', total: { $sum: '$totalPrice' }, count: { $sum: 1 } } }]),
    Payslip.aggregate([{ $group: { _id: '$status', total: { $sum: '$netAmount' }, count: { $sum: 1 } } }])
  ]);

  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, { total: r.total, count: r.count }]));

  return ok(res, {
    fees: toMap(feeAgg),
    marketplaceOrders: toMap(orderAgg),
    payroll: toMap(payrollAgg)
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
    Job.countDocuments({ status: 'open' }),
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

module.exports = { getFinanceSummary, getPlatformReports };
