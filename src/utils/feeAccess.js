const Fee = require('../models/Fee');
const AppError = require('./AppError');

function dueCutoff() {
  const value = new Date();
  value.setHours(23, 59, 59, 999);
  return value;
}

async function getBlockingInstitutionFee(studentId, institutionId) {
  if (!institutionId) return null;
  // Fee clearance (Point 22): until the admission fee is paid the enrolment is not active, whatever its due date.
  const admission = await Fee.findOne({ student: studentId, institution: institutionId, feeType: 'admission', status: { $nin: ['paid', 'refunded', 'waived', 'cancelled'] } });
  if (admission) return admission;
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

// Capability-aware version (spec 15D.7 lifecycle) — the institution picks ONE restriction policy
// per fee plan (none/warning/block_materials/block_assignments/block_exams/block_live_classes/
// block_certificates/block_all), and this only actually blocks the ONE capability that policy
// names (or everything, for block_all). A legacy blocking fee with no FeeSchedule attached falls
// back to the original blanket behavior — never weaker than before this feature existed.
const CAPABILITY_POLICY = {
  materials: 'block_materials', assignments: 'block_assignments', exams: 'block_exams',
  live_classes: 'block_live_classes', certificates: 'block_certificates'
};

async function assertFeeAccessForCapability(studentId, institutionId, capability) {
  const fee = await getBlockingInstitutionFee(studentId, institutionId);
  if (!fee) return;
  const Fee = require('../models/Fee');
  const populated = fee.schedule ? await Fee.findById(fee._id).populate('schedule') : null;
  // The admission fee always blocks everything: the enrolment starts once it is paid.
  const policy = fee.feeType === 'admission' ? 'block_all' : (populated?.schedule?.accessRestrictionPolicy ?? 'block_all'); // no schedule = legacy = always block, as before

  if (policy === 'none' || policy === 'warning') return; // warning is surfaced elsewhere, never enforced here
  if (policy !== 'block_all' && policy !== CAPABILITY_POLICY[capability]) return; // this policy doesn't touch this capability

  const state = fee.status === 'processing' ? 'awaiting institution confirmation' : 'unpaid';
  if (fee.feeType === 'admission') throw new AppError(`Your admission becomes active once ${fee.title} is paid (it is ${state}).`, 402);
  throw new AppError(`Access is locked because ${fee.title} is ${state}. Complete the due payment first.`, 402);
}

module.exports = { getBlockingInstitutionFee, assertInstitutionFeeAccess, assertFeeAccessForCapability };
