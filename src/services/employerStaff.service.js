const mongoose = require('mongoose');
const EmployerStaff = require('../models/EmployerStaff');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('./notification.service');

const fail = (message, status = 422) => new AppError(message, status);

// What each permission lets a staff member do; every one is enforced on the server.
const PERMISSIONS = {
  post_jobs: 'Post and edit the company\'s jobs',
  manage_applicants: 'Review applicants, shortlist and schedule interviews',
  make_offers: 'Send job offers and offer letters',
  view_reports: 'See the hiring dashboard and reports',
  manage_payments: 'Pay for job promotions and packages',
  manage_employees: 'See employees and end employment'
};
const ROLES = {
  hr: { label: 'HR', permissions: ['manage_applicants', 'make_offers', 'manage_employees'] },
  finance: { label: 'Finance', permissions: ['manage_payments', 'view_reports'] },
  manager: { label: 'Manager', permissions: ['post_jobs', 'manage_applicants', 'make_offers', 'view_reports'] },
  recruiter: { label: 'Recruiter', permissions: ['post_jobs', 'manage_applicants'] },
  supervisor: { label: 'Supervisor', permissions: ['view_reports', 'manage_employees'] }
};
const STAFF_LINK = '/dashboard?ws=company_staff&tab=companyWork';

function cleanPermissions(role, list) {
  const picked = list === undefined ? ROLES[role].permissions : [].concat(list || []);
  return [...new Set(picked.filter((p) => PERMISSIONS[p]))];
}

async function assertEmployer(user) {
  if (!(await isRoleVerified(user._id, 'employer'))) throw fail('Only a verified employer can manage company staff.', 403);
}

// The employer adds a CareerZ account (by email) as staff; it waits for the member to accept.
async function invite(user, { email, role, permissions } = {}) {
  await assertEmployer(user);
  if (!ROLES[role]) throw fail('Choose a staff role: HR, Finance, Manager, Recruiter or Supervisor.');
  const member = await User.findOne({ email: String(email || '').trim().toLowerCase() }).select('fullName email status');
  if (!member) throw fail('No CareerZ account uses this email. Ask the person to sign up first.', 404);
  if (String(member._id) === String(user._id)) throw fail('You already own this company account.');
  if (member.status !== 'active') throw fail('This account is not active.', 409);
  const perms = cleanPermissions(role, permissions);
  if (!perms.length) throw fail('Give at least one permission.');
  let row = await EmployerStaff.findOne({ employer: user._id, member: member._id });
  if (row && ['invited', 'active'].includes(row.status)) throw fail('This person is already on your staff list.', 409);
  if (!row) row = new EmployerStaff({ employer: user._id, member: member._id });
  Object.assign(row, { role, permissions: perms, status: 'invited', invitedBy: user._id, respondedAt: null, removedAt: null });
  await row.save();
  await notify(member._id, { title: `${user.fullName} added you as company staff (${ROLES[role].label})`, body: 'Open Company Staff on your dashboard to accept or decline.', sentBy: user._id, link: STAFF_LINK, category: 'employer_staff' }, { email: true }).catch(() => {});
  return row.populate('member', 'fullName email');
}

async function list(user) {
  await assertEmployer(user);
  return EmployerStaff.find({ employer: user._id, status: { $in: ['invited', 'active', 'declined'] } }).populate('member', 'fullName email').sort({ createdAt: -1 }).lean();
}

async function ownRow(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Staff member not found.', 404);
  const row = await EmployerStaff.findOne({ _id: id, employer: user._id });
  if (!row || row.status === 'removed') throw fail('Staff member not found.', 404);
  return row;
}

async function update(user, id, { role, permissions } = {}) {
  await assertEmployer(user);
  const row = await ownRow(user, id);
  if (role !== undefined) { if (!ROLES[role]) throw fail('Choose a valid staff role.'); row.role = role; }
  if (permissions !== undefined || role !== undefined) row.permissions = cleanPermissions(row.role, permissions);
  if (!row.permissions.length) throw fail('Give at least one permission.');
  await row.save();
  return row.populate('member', 'fullName email');
}

async function remove(user, id) {
  await assertEmployer(user);
  const row = await ownRow(user, id);
  row.status = 'removed';
  row.removedAt = new Date();
  await row.save();
  await notify(row.member, { title: `${user.fullName} removed you from company staff`, sentBy: user._id, category: 'employer_staff' }).catch(() => {});
  return row;
}

// The member's side: invitations and the companies they work for.
async function mine(user) {
  return EmployerStaff.find({ member: user._id, status: { $in: ['invited', 'active'] } }).populate('employer', 'fullName email').sort({ createdAt: -1 }).lean();
}

async function respond(user, id, decision) {
  if (!['accepted', 'declined'].includes(decision)) throw fail('decision must be accepted or declined.');
  if (!mongoose.isValidObjectId(id)) throw fail('Invitation not found.', 404);
  const row = await EmployerStaff.findOne({ _id: id, member: user._id, status: 'invited' });
  if (!row) throw fail('Invitation not found.', 404);
  row.status = decision === 'accepted' ? 'active' : 'declined';
  row.respondedAt = new Date();
  await row.save();
  await notify(row.employer, { title: `${user.fullName} ${decision} your company staff invitation`, sentBy: user._id, link: '/dashboard?ws=employer&tab=staff', category: 'employer_staff' }).catch(() => {});
  return row;
}

async function leave(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Not found.', 404);
  const row = await EmployerStaff.findOne({ _id: id, member: user._id, status: 'active' });
  if (!row) throw fail('Not found.', 404);
  row.status = 'removed';
  row.removedAt = new Date();
  await row.save();
  await notify(row.employer, { title: `${user.fullName} left your company staff`, sentBy: user._id, category: 'employer_staff' }).catch(() => {});
  return row;
}

// Does this user hold one of these permissions as active staff of this employer?
async function hasPermission(userId, employerId, perms) {
  if (!userId || !employerId) return false;
  const wanted = [].concat(perms);
  return Boolean(await EmployerStaff.exists({ employer: employerId, member: userId, status: 'active', permissions: { $in: wanted } }));
}
async function assertPermission(userId, employerId, perm) {
  if (!mongoose.isValidObjectId(employerId)) throw fail('Company not found.', 404);
  if (!(await hasPermission(userId, employerId, perm))) throw fail(`You need the "${PERMISSIONS[perm] || perm}" permission for this company.`, 403);
}
// Employers this user works for with any of these permissions.
async function employersFor(userId, perms) {
  return EmployerStaff.distinct('employer', { member: userId, status: 'active', permissions: { $in: [].concat(perms) } });
}

// Express middleware: ?employer=<id> (or body.employer) acts for that company as staff with the
// permission; otherwise the user must hold one of the given roles and acts for themselves.
function actingEmployer(perm, ...roles) {
  return (req, res, next) => {
    const id = req.query.employer || req.body?.employer;
    if (!id) {
      if (roles.length) {
        const held = req.accessibleRoles || req.user.roles;
        if (!req.user.roles.includes('super_admin') && !roles.some((r) => held.includes(r))) return next(new AppError('This action requires a different role.', 403));
      }
      req.actingFor = req.user._id;
      return next();
    }
    assertPermission(req.user._id, id, perm).then(() => { req.actingFor = new mongoose.Types.ObjectId(String(id)); next(); }, next);
  };
}

module.exports = { PERMISSIONS, ROLES, invite, list, update, remove, mine, respond, leave, hasPermission, assertPermission, employersFor, actingEmployer };
