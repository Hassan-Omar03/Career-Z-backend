const Institution = require('../models/Institution');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const Enrollment = require('../models/Enrollment');

// Client scope 8.1 (AIOU style): an institution's courses are listed only to its own people. A visitor
// sees independent teachers' courses only; a signed-in person also sees the courses of institutions
// they study at, own or work for, and any course they are enrolled in. Admins see everything.
async function visibleCourseClause(user) {
  if (!user) return { institution: null };
  if ((user.roles || []).some((r) => ['admin', 'super_admin'].includes(r))) return {};
  const [studying, managing, enrolled] = await Promise.all([
    StudentInstitutionMembership.distinct('institution', { student: user._id, status: 'active' }),
    Institution.distinct('_id', { $or: [{ owner: user._id }, { 'staff.user': user._id }] }),
    Enrollment.distinct('course', { student: user._id })
  ]);
  return { $or: [{ institution: null }, { institution: { $in: [...studying, ...managing] } }, { _id: { $in: enrolled } }] };
}

module.exports = { visibleCourseClause };
