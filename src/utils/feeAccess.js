const Fee = require('../models/Fee');
const AppError = require('./AppError');

function dueCutoff() {
  const value = new Date();
  value.setHours(23, 59, 59, 999);
  return value;
}

async function getBlockingInstitutionFee(studentId, institutionId) {
  if (!institutionId) return null;
  return Fee.findOne({
    student: studentId,
    institution: institutionId,
    status: { $nin: ['paid', 'refunded'] },
    $or: [{ dueDate: null }, { dueDate: { $lte: dueCutoff() } }]
  }).sort({ dueDate: 1, createdAt: 1 });
}

async function assertInstitutionFeeAccess(studentId, institutionId) {
  const fee = await getBlockingInstitutionFee(studentId, institutionId);
  if (fee) {
    const state = fee.status === 'processing' ? 'awaiting institution confirmation' : 'unpaid';
    throw new AppError(`Class access is locked because ${fee.title} is ${state}. Complete the due payment first.`, 402);
  }
}

module.exports = { getBlockingInstitutionFee, assertInstitutionFeeAccess };
