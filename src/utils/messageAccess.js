const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const ParentChildLink = require('../models/ParentChildLink');
const TeacherEmployment = require('../models/TeacherEmployment');
const User = require('../models/User');
const BlockedUser = require('../models/BlockedUser');

function idsEqual(a, b) { return String(a?._id || a || '') === String(b?._id || b || ''); }

async function institutionIdsFor(userId) {
  const [owned, staffed, memberships, profile, employments] = await Promise.all([
    Institution.find({ owner: userId }).distinct('_id'),
    Institution.find({ 'staff.user': userId }).distinct('_id'),
    StudentInstitutionMembership.find({ student: userId, status: 'active' }).distinct('institution'),
    StudentProfile.findOne({ user: userId }).select('primaryInstitution'),
    TeacherEmployment.find({ teacher: userId, status: 'active' }).distinct('institution')
  ]);
  return new Set([...owned, ...staffed, ...memberships, ...(profile?.primaryInstitution ? [profile.primaryInstitution] : []), ...employments].map(String));
}

async function canCommunicate(fromId, toId) {
  if (idsEqual(fromId, toId)) return false;
  const [from, to] = await Promise.all([User.findById(fromId).select('roles'), User.findById(toId).select('roles')]);
  if (!from || !to) return false;
  if (from.roles?.includes('super_admin') || to.roles?.includes('super_admin')) return true;
  // A block always wins over an otherwise-valid shared-institution/course/parent link — the
  // blocker's decision to cut contact is never silently overridden by an unrelated relationship.
  if (await BlockedUser.exists({ $or: [{ blocker: fromId, blocked: toId }, { blocker: toId, blocked: fromId }] })) return false;

  const [fromInstitutions, toInstitutions, fromTaughtIds, toTaughtIds, parentLink] = await Promise.all([
    institutionIdsFor(fromId), institutionIdsFor(toId),
    Course.find({ teacher: fromId }).distinct('_id'),
    Course.find({ teacher: toId }).distinct('_id'),
    ParentChildLink.exists({ status: 'approved', $or: [{ parent: fromId, student: toId }, { parent: toId, student: fromId }] })
  ]);
  if ([...fromInstitutions].some((id) => toInstitutions.has(id))) return true;
  const directCourse = await Enrollment.exists({ status: { $ne: 'dropped' }, $or: [{ student: toId, course: { $in: fromTaughtIds } }, { student: fromId, course: { $in: toTaughtIds } }] });
  return Boolean(directCourse || parentLink);
}

async function communicationContacts(userId) {
  const me = await User.findById(userId).select('roles');
  if (!me) return [];
  const contactMap = new Map();
  const add = (user, relationship, context = '') => {
    if (!user || idsEqual(user, userId)) return;
    const id = String(user._id || user);
    const existing = contactMap.get(id);
    contactMap.set(id, { user, relationship: existing?.relationship || relationship, context: existing?.context || context });
  };

  const taught = await Course.find({ teacher: userId }).select('_id title institution');
  for (const course of taught) {
    const enrollments = await Enrollment.find({ course: course._id, status: { $ne: 'dropped' } }).populate('student', 'fullName email roles profilePhoto');
    enrollments.forEach((entry) => add(entry.student, 'student', course.title));
    const studentIds = enrollments.map((entry) => entry.student?._id).filter(Boolean);
    const parents = await ParentChildLink.find({ student: { $in: studentIds }, status: 'approved' }).populate('parent', 'fullName email roles profilePhoto');
    parents.forEach((link) => add(link.parent, 'parent', course.title));
  }

  const myEnrollments = await Enrollment.find({ student: userId, status: { $ne: 'dropped' } }).populate({ path: 'course', populate: { path: 'teacher', select: 'fullName email roles profilePhoto' } });
  myEnrollments.forEach((entry) => add(entry.course?.teacher, 'teacher', entry.course?.title || 'Course'));

  const institutionIds = [...await institutionIdsFor(userId)];
  const institutions = await Institution.find({ _id: { $in: institutionIds } }).populate('owner', 'fullName email roles profilePhoto').populate('staff.user', 'fullName email roles profilePhoto');
  for (const institution of institutions) {
    add(institution.owner, 'institution', institution.name);
    institution.staff.forEach((entry) => add(entry.user, entry.role === 'teacher' ? 'teacher' : 'institution', institution.name));
    if (me.roles?.some((role) => ['institution_owner', 'institution_staff', 'academy_owner'].includes(role))) {
      const students = await StudentProfile.find({ primaryInstitution: institution._id }).populate('user', 'fullName email roles profilePhoto');
      students.forEach((profile) => add(profile.user, 'student', institution.name));
    }
  }

  const childLinks = await ParentChildLink.find({ parent: userId, status: 'approved' }).populate('student', 'fullName email roles profilePhoto');
  childLinks.forEach((link) => add(link.student, 'student', 'Linked child'));

  return [...contactMap.values()].sort((a, b) => String(a.user.fullName).localeCompare(String(b.user.fullName)));
}

module.exports = { canCommunicate, communicationContacts };
