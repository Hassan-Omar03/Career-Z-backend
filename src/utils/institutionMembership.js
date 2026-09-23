const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const StudentProfile = require('../models/StudentProfile');

// Records a student joining an institution — the first one they ever join becomes primary
// (keeps StudentProfile.primaryInstitution meaningful for all the existing code that reads it);
// any institution joined after that is a real simultaneous membership, not a silent overwrite.
async function recordJoin(studentUserId, institutionId, program) {
  const existing = await StudentInstitutionMembership.findOne({ student: studentUserId, institution: institutionId });
  if (existing) {
    if (existing.status !== 'active') {
      existing.status = 'active';
      existing.leftAt = null;
      existing.joinedAt = new Date();
      await existing.save();
    }
    return existing;
  }

  const hasAnyActive = await StudentInstitutionMembership.exists({ student: studentUserId, status: 'active' });
  const membership = await StudentInstitutionMembership.create({
    student: studentUserId, institution: institutionId, program: program || '',
    status: 'active', isPrimary: !hasAnyActive
  });

  if (membership.isPrimary) {
    // upsert: true — this function must be safe to call on its own (not just from callers that
    // happen to have already created a StudentProfile first), otherwise it silently no-ops.
    await StudentProfile.findOneAndUpdate({ user: studentUserId }, { $set: { primaryInstitution: institutionId } }, { upsert: true });
  }
  return membership;
}

// Records a student leaving an institution (transferred/graduated/withdrawn) — if it was their
// primary one, promotes the next-active membership (if any) to primary so
// StudentProfile.primaryInstitution keeps pointing somewhere real.
async function recordLeave(studentUserId, institutionId, status, reason) {
  const membership = await StudentInstitutionMembership.findOne({ student: studentUserId, institution: institutionId });
  if (!membership) return null;

  const wasPrimary = membership.isPrimary;
  membership.status = status;
  membership.leftAt = new Date();
  membership.reason = reason || '';
  membership.isPrimary = false;
  await membership.save();

  if (wasPrimary) {
    const next = await StudentInstitutionMembership.findOne({ student: studentUserId, status: 'active' }).sort({ joinedAt: 1 });
    if (next) {
      next.isPrimary = true;
      await next.save();
    }
    await StudentProfile.findOneAndUpdate({ user: studentUserId }, { $set: { primaryInstitution: next ? next.institution : null } });
  }
  return membership;
}

module.exports = { recordJoin, recordLeave };
