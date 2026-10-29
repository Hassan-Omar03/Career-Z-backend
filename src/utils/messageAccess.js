const family=require('../services/familyAccess.service');
﻿const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const ParentChildLink = require('../models/ParentChildLink');
const TeacherEmployment = require('../models/TeacherEmployment');
const User = require('../models/User');
const BlockedUser = require('../models/BlockedUser');
const HostelRoom = require('../models/HostelRoom');
const Vehicle = require('../models/Vehicle');

function idsEqual(a, b) { return String(a?._id || a || '') === String(b?._id || b || ''); }

// An education agent's contacts: candidates who applied to its jobs, the employers it posts for,
// and the owners of institutes it has an open recruitment request or agreement with.
async function agentContacts(agentId) {
  const Job = require('../models/Job');
  const JobApplication = require('../models/JobApplication');
  const RecruitmentRequest = require('../models/RecruitmentRequest');
  const fields = 'fullName email roles profilePhoto';
  const jobs = await Job.find({ postedBy: agentId }).select('_id title representedEmployer').populate('representedEmployer', fields);
  const [applications, requests] = await Promise.all([
    JobApplication.find({ job: { $in: jobs.map((j) => j._id) } }).select('job applicant').populate('applicant', fields),
    RecruitmentRequest.find({ agent: agentId, status: { $nin: ['rejected', 'cancelled'] } }).select('institution').populate({ path: 'institution', select: 'name owner', populate: { path: 'owner', select: fields } })
  ]);
  const title = new Map(jobs.map((j) => [String(j._id), j.title]));
  const out = [];
  applications.forEach((a) => a.applicant && out.push({ user: a.applicant, relationship: 'candidate', context: title.get(String(a.job)) || 'Job applicant' }));
  jobs.forEach((j) => j.representedEmployer && out.push({ user: j.representedEmployer, relationship: 'employer', context: j.title }));
  requests.forEach((r) => r.institution?.owner && out.push({ user: r.institution.owner, relationship: 'institution', context: r.institution.name }));
  return out;
}
async function agentLinked(agentId, otherId) {
  return (await agentContacts(agentId)).some((c) => idsEqual(c.user, otherId));
}

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

async function operationalStaffScope(userId) {
  const employments = await TeacherEmployment.find({
    teacher: userId,
    status: 'active',
    role: { $in: ['warden', 'driver'] }
  }).select('role');
  if (!employments.length) return null;

  const roles = new Set(employments.map((entry) => entry.role));
  const [rooms, vehicles] = await Promise.all([
    roles.has('warden') ? HostelRoom.find({ warden: userId }).select('occupants') : [],
    roles.has('driver') ? Vehicle.find({ driverUser: userId }).select('assignedStudents') : []
  ]);
  const studentIds = new Set([
    ...rooms.flatMap((room) => room.occupants || []),
    ...vehicles.flatMap((vehicle) => vehicle.assignedStudents || [])
  ].map(String));
  return { roles, studentIds };
}

// Work, sponsorship and partnership links (master Universal Messaging: Employer ↔ Candidate,
// Institution ↔ Institution, Platform ↔ partners): who applied to whose job, company staff,
// institute–employer partnerships, a teacher's direct (tutoring) students, a donor's sponsored
// students and a visa case's consultant. Each pair is a real record, never "anyone".
const M = (n) => require(`../models/${n}`);
async function workContacts(userId) {
  const out = [];
  const add = (user, relationship, context) => { if (user && !idsEqual(user, userId)) out.push({ user, relationship, context }); };
  const PEOPLE = 'fullName email roles profilePhoto';
  const employers = [userId, ...await M('EmployerStaff').find({ member: userId, status: 'active' }).distinct('employer')];
  const jobs = await M('Job').find({ postedBy: { $in: employers } }).select('_id title').limit(500).lean();
  const titles = new Map(jobs.map((j) => [String(j._id), j.title]));
  const apps = await M('JobApplication').find({ job: { $in: jobs.map((j) => j._id) }, status: { $ne: 'withdrawn' } }).populate('applicant', PEOPLE).sort({ createdAt: -1 }).limit(500).lean();
  apps.forEach((a) => add(a.applicant, 'candidate', titles.get(String(a.job)) || 'Job applicant'));
  const mine = await M('JobApplication').find({ applicant: userId, status: { $ne: 'withdrawn' } }).populate({ path: 'job', select: 'title company postedBy', populate: { path: 'postedBy', select: PEOPLE } }).limit(200).lean();
  mine.forEach((a) => add(a.job?.postedBy, 'employer', a.job ? `${a.job.title} @ ${a.job.company}` : 'Job'));
  const staff = await M('EmployerStaff').find({ status: 'active', $or: [{ employer: userId }, { member: userId }] }).populate('employer', PEOPLE).populate('member', PEOPLE).lean();
  staff.forEach((s) => { add(s.employer, 'employer', 'Company staff'); add(s.member, 'company staff', 'Company staff'); });
  const owned = await Institution.find({ owner: userId }).distinct('_id');
  const partners = await M('InstitutionEmployerPartnership').find({ status: 'active', $or: [{ employer: userId }, { institution: { $in: owned } }] }).populate('employer', PEOPLE).populate({ path: 'institution', select: 'name owner', populate: { path: 'owner', select: PEOPLE } }).lean();
  partners.forEach((p) => { add(p.employer, 'partner employer', p.institution?.name || 'Partnership'); add(p.institution?.owner, 'partner institution', p.institution?.name || 'Partnership'); });
  const tutoring = await M('TeacherStudentLink').find({ status: { $in: ['active', 'paused'] }, $or: [{ teacher: userId }, { student: userId }] }).populate('teacher', PEOPLE).populate('student', PEOPLE).lean();
  tutoring.forEach((l) => { add(l.teacher, 'teacher', 'Direct teaching'); add(l.student, 'student', 'Direct teaching'); });
  const sponsored = await M('Sponsorship').find({ status: { $in: ['active', 'paused', 'completed'] }, $or: [{ donor: userId }, { student: userId }] }).populate('donor', PEOPLE).populate('student', PEOPLE).lean();
  sponsored.forEach((s) => { add(s.donor, 'sponsor', 'Scholarship sponsorship'); add(s.student, 'sponsored student', 'Scholarship sponsorship'); });
  const visas = await M('VisaCase').find({ consultant: { $ne: null }, $or: [{ consultant: userId }, { candidate: userId }, { hiringSide: userId }] }).populate('consultant', PEOPLE).populate('candidate', PEOPLE).populate('hiringSide', PEOPLE).lean();
  visas.forEach((v) => { add(v.consultant, 'visa consultant', 'Visa case'); add(v.candidate, 'candidate', 'Visa case'); add(v.hiringSide, 'employer', 'Visa case'); });
  return out;
}
async function workLinked(fromId, toId) {
  return (await workContacts(fromId)).some((c) => idsEqual(c.user, toId));
}
// Institution ↔ Institution: owners of two approved institutes may talk to each other.
async function institutionPeers(fromId, toId) {
  const q = (id) => Institution.exists({ owner: id, verificationStatus: 'approved' });
  return Boolean(await q(fromId) && await q(toId));
}

async function canCommunicate(fromId, toId) {
  if (idsEqual(fromId, toId)) return false;
  const [from, to] = await Promise.all([User.findById(fromId).select('roles'), User.findById(toId).select('roles')]);
  if (!from || !to) return false;
  if (from.roles?.includes('super_admin') || to.roles?.includes('super_admin')) return true;
  // A block always wins over an otherwise-valid shared-institution/course/parent link — the
  // blocker's decision to cut contact is never silently overridden by an unrelated relationship.
  if (await BlockedUser.exists({ $or: [{ blocker: fromId, blocked: toId }, { blocker: toId, blocked: fromId }] })) return false;

  if (from.roles?.includes('education_agent') && await agentLinked(fromId, toId)) return true;
  if (to.roles?.includes('education_agent') && await agentLinked(toId, fromId)) return true;

  if (await require('../models/Order').exists({ $or: [{ buyer: fromId, seller: toId }, { buyer: toId, seller: fromId }] })) return true;
  if (await workLinked(fromId, toId) || await institutionPeers(fromId, toId)) return true;

  const [fromScope, toScope] = await Promise.all([operationalStaffScope(fromId), operationalStaffScope(toId)]);
  if (fromScope) return to.roles?.includes('student') && fromScope.studentIds.has(String(toId));
  if (toScope) return from.roles?.includes('student') && toScope.studentIds.has(String(fromId));

  const [fromInstitutions, toInstitutions, fromTaughtIds, toTaughtIds, parentLink] = await Promise.all([
    institutionIdsFor(fromId), institutionIdsFor(toId),
    Course.find({ teacher: fromId }).distinct('_id'),
    Course.find({ teacher: toId }).distinct('_id'),
    ParentChildLink.exists({ status: 'approved', $or: [{ parent: fromId, student: toId }, { parent: toId, student: fromId }] })
  ]);
  if(await family.related(fromId,toId)||await family.related(toId,fromId))return true;
  if((await family.groupContacts(fromId)).some(c=>idsEqual(c.user,toId)))return true;
  if ([...fromInstitutions].some((id) => toInstitutions.has(id))) return true;
  const directCourse = await Enrollment.exists({ status: { $ne: 'dropped' }, $or: [{ student: toId, course: { $in: fromTaughtIds } }, { student: fromId, course: { $in: toTaughtIds } }] });
  return Boolean(directCourse || parentLink);
}

async function communicationContacts(userId) {
  const me = await User.findById(userId).select('roles');
  if (!me) return [];
  const staffScope = await operationalStaffScope(userId);
  if (staffScope) {
    const students = await User.find({ _id: { $in: [...staffScope.studentIds] }, roles: 'student' })
      .select('fullName email roles profilePhoto')
      .sort({ fullName: 1 });
    return students.map((student) => ({
      user: student,
      relationship: 'assigned student',
      context: staffScope.roles.has('warden') && staffScope.roles.has('driver')
        ? 'Assigned hostel/transport student'
        : staffScope.roles.has('warden') ? 'Assigned hostel resident' : 'Assigned transport student'
    }));
  }
  const contactMap = new Map();
  const add = (user, relationship, context = '') => {
    if (!user || idsEqual(user, userId)) return;
    const id = String(user._id || user);
    const existing = contactMap.get(id);
    contactMap.set(id, { user, relationship: existing?.relationship || relationship, context: existing?.context || context });
  };

  if (me.roles?.includes('education_agent')) for (const c of await agentContacts(userId)) add(c.user, c.relationship, c.context);
  for (const c of await workContacts(userId)) add(c.user, c.relationship, c.context);

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

  for(const c of [...await family.contacts(userId),...await family.groupContacts(userId)])add(c.user,c.relationship,c.context);
  for(const id of institutionIds){const ids=await family.students(id);const i=await Institution.findById(id);if(i&&(idsEqual(i.owner,userId)||i.staff.some(s=>idsEqual(s.user,userId)&&s.role!=='teacher'))){const parents=await ParentChildLink.find({student:{$in:ids},status:'approved'}).populate('parent','fullName email roles profilePhoto');parents.forEach(l=>add(l.parent,'parent',i.name));}}
  return [...contactMap.values()].sort((a, b) => String(a.user.fullName).localeCompare(String(b.user.fullName)));
}

module.exports = { canCommunicate, communicationContacts, operationalStaffScope };
