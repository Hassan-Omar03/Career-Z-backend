const TeacherProfile = require('../models/TeacherProfile');
const User = require('../models/User');

// Shared side effects of a person actually becoming institution staff — used by both the direct
// addStaff endpoint and an accepted TeacherEmployment offer, so the two paths can never drift.
async function onboardStaff(institution, userId, { role, department, designation, permissions }) {
  institution.staff.push({ user: userId, role, department: department || '', designation: designation || '', permissions: permissions || [] });
  await institution.save();

  const staffUser = await User.findById(userId);
  // A teacher works from the Teacher workspace; the institution workspace (fees, staff, admin
  // figures) is only for staff who run the institute (non-teacher roles or granted permissions).
  const runsInstitute = role !== 'teacher' || (permissions || []).length > 0;
  if (staffUser && runsInstitute && !staffUser.roles.includes('institution_staff')) {
    staffUser.roles.push('institution_staff');
    await staffUser.save();
  }

  if (role === 'teacher') {
    await TeacherProfile.findOneAndUpdate({ user: userId }, { $addToSet: { institutions: institution._id } }, { upsert: true });
  }
}

// Shared side effects of someone leaving institution staff (removed, resigned or terminated).
async function offboardStaff(institution, userId) {
  institution.staff = institution.staff.filter((s) => s.user.toString() !== userId.toString());
  await institution.save();
  await TeacherProfile.findOneAndUpdate({ user: userId }, { $pull: { institutions: institution._id } });
}

module.exports = { onboardStaff, offboardStaff };
