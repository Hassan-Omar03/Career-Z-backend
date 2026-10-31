const crypto = require('crypto');
const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const Invite = require('../models/InstitutionInvite');
const Institution = require('../models/Institution');
const User = require('../models/User');
const RoleRequest = require('../models/RoleRequest');
const UserProfile = require('../models/UserProfile');
const TeacherEmployment = require('../models/TeacherEmployment');
const staffRoles = require('../utils/staffRoles');
const { onboardStaff } = require('../utils/staffOnboarding');
const { recordJoin } = require('../utils/institutionMembership');
const { sendEmail, noticeEmailTemplate } = require('./email.service');
const { notify, escapeHtml } = require('./notification.service');

// Institute invitations by email: an institute (for example a university already on CareerZ)
// invites its teachers, staff and students by email. The email has a one-time "Join" link.
//  - No CareerZ account yet: the link opens a short sign-up (email already filled in, or Google);
//    the account is created and joined to the institute in one step and opens straight on its
//    dashboard. Opening the emailed link proves the email, and the verified institute vouches
//    for the person, so there is no separate document check for this work.
//  - Already on CareerZ: sign in with the same email and press Accept.
// Teachers join as teachers (with an active employment), staff with their staff role and its
// permissions, students as active members of the institute (with a class if chosen).

const fail = (message, status = 422) => new AppError(message, status);
const DAYS = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const site = () => (process.env.PUBLIC_SITE_URL || 'https://careerz.pk').replace(/\/$/, '');
const KIND_ROLE = { teacher: 'teacher', staff: 'institution_staff', student: 'student' };
const KIND_LABEL = { teacher: 'teacher', staff: 'staff member', student: 'student' };

// Owner, or staff allowed to hire (teachers/staff) or manage students (students).
async function institutionFor(user, id, kind) {
  if (!mongoose.isValidObjectId(id)) throw fail('Institute not found.', 404);
  const inst = await Institution.findById(id);
  if (!inst) throw fail('Institute not found.', 404);
  const isOwner = String(inst.owner) === String(user._id);
  const member = inst.staff.find((s) => String(s.user) === String(user._id));
  const perms = member?.permissions || [];
  const allowed = isOwner || (kind === 'student' ? perms.some((p) => ['students:manage', 'application:approve'].includes(p)) : perms.includes('recruitment:manage')) || (!kind && member && perms.length);
  if (!allowed) throw fail('Only the institute owner (or staff allowed to hire / manage students) can send invitations.', 403);
  if (inst.verificationStatus !== 'approved') throw fail('Your institute must be verified by CareerZ before it can invite people.', 403);
  return inst;
}

function link(token) { return `${site()}/invite/${token}`; }
async function emailInvite(inv, inst, token, inviter) {
  const who = KIND_LABEL[inv.kind];
  const roleText = inv.kind === 'staff' ? ` as ${staffRoles.STAFF_ROLES[inv.role]?.label || inv.role}` : inv.kind === 'teacher' && inv.designation ? ` as ${inv.designation}` : '';
  const subject = `${inst.name} invited you to join CareerZ`;
  const lines = [
    `Assalam o Alaikum${inv.name ? ` ${inv.name}` : ''},`,
    `${inst.name} has invited you to join them on CareerZ as a ${who}${roleText}${inv.department ? ` (${inv.department})` : ''}.`,
    inv.message ? `Message from ${inst.name}: "${inv.message}"` : '',
    inv.kind === 'teacher' ? 'On CareerZ you will see your timetable, classes and students, take attendance, run live classes, upload lessons and exams, and get your payslips, all in one place.'
      : inv.kind === 'student' ? 'On CareerZ you will see your timetable, classes, attendance, homework, exams, results and fees, and join online classes, all in one place.'
        : 'On CareerZ you will manage your institute work from your own dashboard.',
    'Press "Join" below. If you are new to CareerZ, just choose a password (or continue with Google), your account opens straight away. If you already have a CareerZ account with this email, sign in and accept.',
    `This invitation is for ${inv.email} and is valid for ${DAYS} days.`
  ].filter(Boolean);
  await sendEmail({
    to: inv.email, subject,
    text: `${lines.join('\n\n')}\n\nJoin: ${link(token)}\n\n${inviter?.fullName ? `Sent by ${inviter.fullName} for ${inst.name}.` : ''}`,
    html: noticeEmailTemplate({ heading: escapeHtml(subject), body: lines.map((l) => escapeHtml(l)).join('<br><br>'), ctaUrl: link(token), ctaLabel: `Join ${escapeHtml(inst.name)}`, footer: `If you did not expect this, you can ignore this email.${inviter?.fullName ? ` Sent by ${escapeHtml(inviter.fullName)} for ${escapeHtml(inst.name)}.` : ''}` })
  });
}

async function send(user, institutionId, body = {}) {
  const list = Array.isArray(body.invites) ? body.invites : [body];
  if (!list.length || list.length > 300) throw fail('Send between 1 and 300 invitations at a time.');
  const kinds = new Set(list.map((x) => x.kind || 'teacher'));
  if ([...kinds].some((k) => !KIND_ROLE[k])) throw fail('Each invitation is for a teacher, a staff member or a student.');
  let inst;
  for (const k of kinds) inst = await institutionFor(user, institutionId, k);
  const message = String(body.message || '').trim().slice(0, 500);
  const results = [];
  for (const raw of list) {
    const kind = raw.kind || 'teacher';
    const email = String(raw.email || '').trim().toLowerCase();
    const row = { email, kind };
    try {
      if (!EMAIL.test(email)) throw fail('Not a valid email.');
      const role = kind === 'staff' ? String(raw.role || '') : kind === 'teacher' ? 'teacher' : '';
      if (kind === 'staff') { staffRoles.roleOrThrow(role, AppError); if (role === 'teacher') throw fail('Invite teachers as "Teacher", not as staff.'); }
      const existingUser = await User.findOne({ email }).select('_id').lean();
      if (existingUser && kind !== 'student' && inst.staff.some((s) => String(s.user) === String(existingUser._id))) throw fail('Already on your staff.');
      if (existingUser && kind === 'student' && await require('../models/StudentInstitutionMembership').exists({ student: existingUser._id, institution: inst._id, status: 'active' })) throw fail('Already your student.');
      if (kind !== 'student') await require('../utils/subscriptionGate').assertStaffCapAllows(inst, inst.staff.length);
      let classSection = null;
      if (kind === 'student' && raw.classSection) {
        if (!mongoose.isValidObjectId(raw.classSection) || !(await require('../models/ClassSection').exists({ _id: raw.classSection, institution: inst._id }))) throw fail('Choose a class of your institute.');
        classSection = raw.classSection;
      }
      const token = crypto.randomBytes(24).toString('base64url');
      let inv = await Invite.findOne({ institution: inst._id, email, kind, status: 'sent' }).select('+tokenHash');
      const fields = { name: String(raw.name || '').trim().slice(0, 100), role, designation: String(raw.designation || '').trim().slice(0, 100), department: String(raw.department || '').trim().slice(0, 100), program: String(raw.program || '').trim().slice(0, 100), classSection, message, invitedBy: user._id, tokenHash: hash(token), lastSentAt: new Date(), expiresAt: new Date(Date.now() + DAYS * 864e5) };
      if (inv) { Object.assign(inv, fields); inv.sentCount += 1; await inv.save(); } else inv = await Invite.create({ institution: inst._id, email, kind, ...fields });
      await emailInvite(inv, inst, token, user);
      if (existingUser) await notify(existingUser._id, { title: `${inst.name} invited you to join as a ${KIND_LABEL[kind]}`, body: 'Open the email we sent, or the link below, to accept.', link: `/invite/${token}` }).catch(() => {});
      results.push({ ...row, ok: true, id: inv._id, existingAccount: Boolean(existingUser) });
    } catch (e) {
      results.push({ ...row, ok: false, error: e.message });
    }
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

async function list(user, institutionId, query = {}) {
  const inst = await institutionFor(user, institutionId, query.kind === 'student' ? 'student' : undefined).catch(async (e) => { if (query.kind) throw e; return institutionFor(user, institutionId, 'teacher'); });
  const filter = { institution: inst._id };
  if (KIND_ROLE[query.kind]) filter.kind = query.kind;
  await Invite.updateMany({ institution: inst._id, status: 'sent', expiresAt: { $lt: new Date() } }, { $set: { status: 'expired' } });
  return Invite.find(filter).populate('user', 'fullName email').populate('classSection', 'name').sort({ createdAt: -1 }).limit(500).lean();
}

async function own(user, institutionId, inviteId) {
  if (!mongoose.isValidObjectId(inviteId)) throw fail('Invitation not found.', 404);
  const inv = await Invite.findOne({ _id: inviteId, institution: institutionId }).select('+tokenHash');
  if (!inv) throw fail('Invitation not found.', 404);
  const inst = await institutionFor(user, institutionId, inv.kind);
  return { inv, inst };
}
async function resend(user, institutionId, inviteId) {
  const { inv, inst } = await own(user, institutionId, inviteId);
  if (!['sent', 'expired'].includes(inv.status)) throw fail('Only a pending or expired invitation can be sent again.', 409);
  const token = crypto.randomBytes(24).toString('base64url');
  Object.assign(inv, { tokenHash: hash(token), status: 'sent', lastSentAt: new Date(), expiresAt: new Date(Date.now() + DAYS * 864e5), sentCount: inv.sentCount + 1 });
  await inv.save();
  await emailInvite(inv, inst, token, user);
  return { resent: true };
}
async function cancel(user, institutionId, inviteId) {
  const { inv } = await own(user, institutionId, inviteId);
  if (inv.status !== 'sent') throw fail('Only a pending invitation can be cancelled.', 409);
  inv.status = 'cancelled'; await inv.save();
  return { cancelled: true };
}

// ---------------------------------------------------------------- the person invited
async function byToken(token) {
  const inv = await Invite.findOne({ tokenHash: hash(token) }).populate('institution', 'name logo city type verificationStatus').populate('classSection', 'name');
  if (!inv) throw fail('This invitation link is not valid. Ask the institute to send it again.', 404);
  if (inv.status === 'sent' && inv.expiresAt < new Date()) { inv.status = 'expired'; await inv.save(); }
  return inv;
}
async function preview(token) {
  const inv = await byToken(token);
  return {
    institution: { name: inv.institution?.name, logo: /^https:\/\//.test(inv.institution?.logo || '') ? inv.institution.logo : null, city: inv.institution?.city || '', type: inv.institution?.type || '' },
    email: inv.email, name: inv.name, kind: inv.kind, role: inv.kind === 'staff' ? staffRoles.STAFF_ROLES[inv.role]?.label || inv.role : inv.kind,
    designation: inv.designation, department: inv.department, classSection: inv.classSection?.name || '', message: inv.message,
    status: inv.status, expiresAt: inv.expiresAt, accountExists: Boolean(await User.exists({ email: inv.email }))
  };
}

// The role is usable at once: approved, with its profile marked ready (it can be filled in later).
async function grantRole(userId, role, inst) {
  if (!['teacher', 'student'].includes(role)) return;
  const latest = await RoleRequest.findOne({ user: userId, requestedRole: role }).sort({ createdAt: -1 });
  if (!latest || latest.status !== 'approved') {
    if (latest) Object.assign(latest, { status: 'approved', approvedAt: new Date(), reviewNotes: `Joined through an invitation from ${inst.name}` });
    await (latest || new RoleRequest({ user: userId, requestedRole: role, status: 'approved', approvedAt: new Date(), reviewNotes: `Joined through an invitation from ${inst.name}` })).save();
  }
  await UserProfile.updateOne({ user: userId, role }, { $set: { completed: true }, $max: { percent: 60 } }, { upsert: true });
}

async function join(inv, userId) {
  const inst = await Institution.findById(inv.institution._id || inv.institution);
  if (!inst || inst.verificationStatus !== 'approved') throw fail('This institute is not active on CareerZ right now.', 403);
  const user = await User.findById(userId);
  const role = KIND_ROLE[inv.kind];
  if (role !== 'institution_staff' && !user.roles.includes(role)) { user.roles.push(role); await user.save(); }
  await grantRole(user._id, role, inst);
  if (inv.kind === 'student') {
    await recordJoin(user._id, inst._id, inv.program);
    if (inv.classSection) await require('../models/StudentProfile').updateOne({ user: user._id }, { $set: { classSection: inv.classSection, ...(inv.program ? { program: inv.program } : {}) } }, { upsert: true });
  } else if (!inst.staff.some((s) => String(s.user) === String(user._id))) {
    const permissions = inv.kind === 'staff' ? staffRoles.permissionsFor(inv.role, undefined, AppError) : [];
    await onboardStaff(inst, String(user._id), { role: inv.role || 'teacher', department: inv.department, designation: inv.designation, permissions });
    if (inv.kind === 'teacher') await TeacherEmployment.create({ teacher: user._id, institution: inst._id, role: 'teacher', designation: inv.designation, department: inv.department, status: 'active', offeredBy: inv.invitedBy, respondedAt: new Date(), startedAt: new Date() });
  }
  inv.status = 'accepted'; inv.user = user._id; inv.acceptedAt = new Date();
  await inv.save();
  await notify(inv.invitedBy, { title: `${user.fullName} joined ${inst.name}`, body: `Your invitation to ${inv.email} was accepted (${KIND_LABEL[inv.kind]}).`, link: '/dashboard' }).catch(() => {});
  return { joined: true, kind: inv.kind, institution: inst.name, workspace: inv.kind === 'staff' ? 'institution' : inv.kind };
}

const usable = (inv) => {
  if (inv.status === 'accepted') throw fail('This invitation was already used. Sign in to CareerZ to continue.', 409);
  if (inv.status !== 'sent') throw fail(`This invitation is ${inv.status}. Ask the institute to send a new one.`, 410);
};

// Signed-in person with the invited email.
async function accept(user, token) {
  const inv = await byToken(token);
  usable(inv);
  if (String(user.email).toLowerCase() !== inv.email) throw fail(`This invitation is for ${inv.email}. Sign in with that email to accept it.`, 403);
  return join(inv, user._id);
}

// New person: creates the account from the invitation and joins in one step.
async function signup(token, body = {}, meta = {}) {
  const inv = await byToken(token);
  usable(inv);
  if (await User.exists({ email: inv.email })) throw fail('An account with this email already exists. Sign in to accept the invitation.', 409);
  const fullName = String(body.fullName || inv.name || '').trim().slice(0, 100);
  if (fullName.length < 2) throw fail('Enter your full name.');
  if (body.acceptedTerms !== true) throw fail('Please accept the Terms & Conditions and the Privacy Policy to continue.');
  require('../utils/passwordPolicy').assertStrongPassword(String(body.password || ''));
  const inst = await Institution.findById(inv.institution._id).select('city country');
  const role = KIND_ROLE[inv.kind];
  const user = await User.create({
    fullName, email: inv.email, phone: String(body.phone || '').trim().slice(0, 20) || undefined,
    passwordHash: await User.hashPassword(String(body.password)), roles: role === 'institution_staff' ? [] : [role],
    emailVerified: true, status: 'active', termsAcceptedAt: new Date(),
    country: String(body.country || inst?.country || 'PK').slice(0, 100), city: String(body.city || inst?.city || '').slice(0, 100)
  });
  inv.newAccount = true;
  const result = await join(inv, user._id);
  const tokens = await require('./token.service').issueTokenPair(user, meta);
  const fresh = await User.findById(user._id);
  return { ...result, user: fresh.toSafeJSON(), permissions: fresh.permissions(), ...tokens };
}

module.exports = { send, list, resend, cancel, preview, accept, signup };
