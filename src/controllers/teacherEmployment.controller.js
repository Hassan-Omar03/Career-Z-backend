const TeacherEmployment = require('../models/TeacherEmployment');
const TeacherProfile = require('../models/TeacherProfile');
const Institution = require('../models/Institution');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const { onboardStaff, offboardStaff } = require('../utils/staffOnboarding');
const { assertStaffCapAllows } = require('../utils/subscriptionGate');
const env = require('../config/env');
const { v2: cloudinary } = require('cloudinary');

function assertOwner(institution, userId) {
  if (institution.owner.toString() !== userId.toString()) throw new AppError('Only the institution owner can manage hiring.', 403);
}

// POST /api/institutions/:id/teacher-offers â€” the real, consent-based alternative to directly
// adding staff (spec: Teacher<->Institution "hiring application/offer/acceptance, employment
// contract"). Nothing changes on the institution or the teacher's account until they accept.
const createOffer = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);
  if (institution.verificationStatus !== 'approved') {
    throw new AppError('This institution must be verified by Super Admin before it can send job offers.', 403);
  }

  const { teacherUserId, role, designation, department, contractTerms, contractDocumentUrl, salaryType, commissionPercent, monthlySalary, salaryCurrency, taxPercent } = req.body;
  if (!teacherUserId || !role) throw new AppError('teacherUserId and role are required.', 422);
  const teacher = await User.findById(teacherUserId);
  if (!teacher) throw new AppError('Teacher not found.', 404);
  if (institution.staff.some((s) => s.user.toString() === teacherUserId)) {
    throw new AppError('This person is already staff at this institution.', 409);
  }
  await assertStaffCapAllows(institution, institution.staff.length);

  const offer = await TeacherEmployment.create({
    teacher: teacherUserId, institution: institution._id, role,
    designation: designation || '', department: department || '', contractTerms: contractTerms || '', contractDocumentUrl: contractDocumentUrl || '', salaryType: salaryType || 'monthly', commissionPercent: Number(commissionPercent || 0), monthlySalary: Number(monthlySalary || 0), salaryCurrency: salaryCurrency || 'PKR', taxPercent: Number(taxPercent || 0),
    status: 'offered', offeredBy: req.user._id
  });

  // Emailed (not just in-app) so a teacher who isn't already sitting on the dashboard still
  // finds out â€” the button drops them straight onto the portal to accept/decline.
  await notify(teacherUserId, {
    title: `Job offer from ${institution.name}`,
    body: `Role: ${role}${designation ? ` (${designation})` : ''}. Review and respond from Employment Offers.`,
    sentBy: req.user._id
  }, {
    email: true,
    toAddress: teacher.email,
    ctaUrl: `${env.clientUrl}/dashboard`,
    ctaLabel: 'Review Offer'
  }).catch(() => {});

  return created(res, offer, 'Offer sent.');
});

// GET /api/institutions/:id/teacher-directory â€” lets an institution browse teachers to hire,
// instead of needing to already know a teacher's exact User ID (which used to be the only way
// to send an offer). Only professional info is exposed here (no email/phone/address) â€” contact
// happens through the offer itself or in-app messaging, never raw personal details in a public
// list. Teachers can opt out via TeacherProfile.visibleToInstitutions.
const listTeacherDirectory = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);

  const alreadyStaffIds = new Set(institution.staff.map((s) => s.user.toString()));
  const { q } = req.query;
  const filter = { visibleToInstitutions: true, status: 'active' };
  if (q && q.trim()) {
    filter.$or = [
      { subjects: { $regex: q.trim(), $options: 'i' } },
      { bio: { $regex: q.trim(), $options: 'i' } }
    ];
  }

  const profiles = await TeacherProfile.find(filter)
    .populate('user', 'fullName profilePhoto')
    .sort({ experienceYears: -1 })
    .limit(100);

  const directory = profiles
    .filter((p) => p.user && !alreadyStaffIds.has(p.user._id.toString()))
    .map((p) => ({
      userId: p.user._id,
      fullName: p.user.fullName,
      profilePhoto: p.user.profilePhoto || '',
      subjects: p.subjects,
      experienceYears: p.experienceYears,
      qualifications: p.qualifications,
      bio: p.bio,
      independent: p.independent
    }));

  return ok(res, directory);
});

// PATCH /api/teacher-employments/:id/respond â€” the teacher accepts or declines. Accepting is
// what actually onboards them (same shared logic as the direct addStaff path).
const respondToOffer = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!['accepted', 'declined'].includes(decision)) throw new AppError('decision must be accepted or declined.', 422);

  const offer = await TeacherEmployment.findById(req.params.id);
  if (!offer) throw new AppError('Offer not found.', 404);
  if (offer.teacher.toString() !== req.user._id.toString()) throw new AppError('This offer is not yours to respond to.', 403);
  if (offer.status !== 'offered') throw new AppError('This offer has already been responded to.', 400);

  offer.respondedAt = new Date();
  if (decision === 'accepted') {
    const institution = await Institution.findById(offer.institution);
    if (!institution) throw new AppError('Institution not found.', 404);
    if (institution.verificationStatus !== 'approved') {
      throw new AppError('This institution is no longer verified â€” it cannot be accepted until Super Admin re-verifies it.', 403);
    }
    if (institution.staff.some((s) => s.user.toString() === offer.teacher.toString())) {
      throw new AppError('Already staff at this institution.', 409);
    }
    await onboardStaff(institution, offer.teacher.toString(), { role: offer.role, department: offer.department, designation: offer.designation });
    offer.status = 'active';
    offer.startedAt = new Date();
  } else {
    offer.status = 'declined';
  }
  await offer.save();

  await notify(offer.offeredBy, {
    title: `Offer ${decision}: ${req.user.fullName}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, offer, `Offer ${decision}.`);
});

// POST /api/teacher-employments/:id/resign â€” teacher-initiated departure.
const resign = asyncHandler(async (req, res) => {
  const employment = await TeacherEmployment.findById(req.params.id);
  if (!employment) throw new AppError('Employment record not found.', 404);
  if (employment.teacher.toString() !== req.user._id.toString()) throw new AppError('This is not your employment record.', 403);
  if (employment.status !== 'active') throw new AppError('This employment is not currently active.', 400);

  const institution = await Institution.findById(employment.institution);
  if (institution) await offboardStaff(institution, employment.teacher.toString());

  employment.status = 'resigned';
  employment.endedAt = new Date();
  employment.endReason = req.body.reason || '';
  await employment.save();

  await notify(employment.offeredBy, { title: `${req.user.fullName} resigned`, body: employment.endReason, sentBy: req.user._id }).catch(() => {});
  return ok(res, employment, 'Resignation recorded.');
});

// PATCH /api/teacher-employments/:id/terminate â€” institution-initiated departure.
const terminate = asyncHandler(async (req, res) => {
  const employment = await TeacherEmployment.findById(req.params.id);
  if (!employment) throw new AppError('Employment record not found.', 404);
  const institution = await Institution.findById(employment.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);
  if (employment.status !== 'active') throw new AppError('This employment is not currently active.', 400);

  await offboardStaff(institution, employment.teacher.toString());
  employment.status = 'terminated';
  employment.endedAt = new Date();
  employment.endReason = req.body.reason || '';
  await employment.save();

  await notify(employment.teacher, { title: `Your employment at ${institution.name} was ended`, body: employment.endReason, sentBy: req.user._id }).catch(() => {});
  return ok(res, employment, 'Employment ended.');
});

// GET /api/teacher-employments/mine â€” a teacher's full service history, every institution.
const myEmployments = asyncHandler(async (req, res) => {
  const employments = await TeacherEmployment.find({ teacher: req.user._id })
    .populate('institution', 'name type country logo')
    .sort({ createdAt: -1 });
  return ok(res, employments);
});

// GET /api/teacher-employments/:id/contract-link
// Contract files are intentionally not exposed as permanently public CDN assets. Cloudinary
// environments can also block raw/PDF public delivery with ACL rules. After checking that the
// caller is the teacher or institution owner, issue a short-lived signed download URL instead.
const getContractLink = asyncHandler(async (req, res) => {
  const employment = await TeacherEmployment.findById(req.params.id);
  if (!employment) throw new AppError('Employment record not found.', 404);
  if (!employment.contractDocumentUrl) throw new AppError('No contract document is attached.', 404);

  const institution = await Institution.findById(employment.institution).select('owner');
  const isTeacher = employment.teacher.toString() === req.user._id.toString();
  const isOwner = institution?.owner?.toString() === req.user._id.toString();
  if (!isTeacher && !isOwner) throw new AppError('You cannot access this contract.', 403);

  const parsed = new URL(employment.contractDocumentUrl);
  const marker = '/raw/upload/';
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) throw new AppError('This contract must be uploaded again using the secure document uploader.', 422);
  let publicId = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length)).replace(/^v\d+\//, '');

  cloudinary.config({ cloud_name: env.cloudinary.cloudName, api_key: env.cloudinary.apiKey, api_secret: env.cloudinary.apiSecret, secure: true });
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const url = cloudinary.utils.private_download_url(publicId, undefined, {
    resource_type: 'raw',
    type: 'upload',
    attachment: true,
    expires_at: expiresAt
  });
  return ok(res, { url, expiresAt });
});

// GET /api/institutions/:id/teacher-employments â€” the institution's own hiring history.
const listInstitutionEmployments = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);

  const employments = await TeacherEmployment.find({ institution: institution._id })
    .populate('teacher', 'fullName email')
    .sort({ createdAt: -1 })
    .lean();
  const profiles = await TeacherProfile.find({ user: { $in: employments.map((e) => e.teacher?._id).filter(Boolean) } })
    .select('user subjects qualifications experienceYears bio')
    .lean();
  const profileByUser = new Map(profiles.map((profile) => [profile.user.toString(), profile]));
  return ok(res, employments.map((employment) => ({
    ...employment,
    teacherProfile: profileByUser.get(employment.teacher?._id?.toString()) || null
  })));
});

const updateEmployment = asyncHandler(async (req, res) => {
  const employment = await TeacherEmployment.findById(req.params.id);
  if (!employment) throw new AppError('Employment record not found.', 404);
  if (employment.status !== 'active') throw new AppError('Employment is not active.', 400);
  const institution = await Institution.findById(employment.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  const action = req.body.action;

  if (action === 'request_leave') {
    if (employment.teacher.toString() !== req.user._id.toString()) throw new AppError('Only the teacher can request leave.', 403);
    const from = new Date(req.body.from); const to = new Date(req.body.to);
    if (!req.body.from || !req.body.to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new AppError('Valid leave dates are required.', 422);
    employment.leaveRequests.push({ from, to, reason: req.body.reason || '', status: 'pending' });
  } else {
    assertOwner(institution, req.user._id);
    if (action === 'review_leave') {
      const leave = employment.leaveRequests.id(req.body.leaveId);
      if (!leave || leave.status !== 'pending') throw new AppError('Pending leave request not found.', 404);
      if (!['approved', 'rejected'].includes(req.body.decision)) throw new AppError('decision must be approved or rejected.', 422);
      leave.status = req.body.decision; leave.reviewedBy = req.user._id; leave.reviewedAt = new Date();
    } else if (action === 'promote') {
      if (!req.body.designation?.trim()) throw new AppError('New designation is required.', 422);
      employment.changes.push({ action: 'promotion', fromValue: employment.designation, toValue: req.body.designation.trim(), reason: req.body.reason || '', changedBy: req.user._id });
      employment.designation = req.body.designation.trim();
    } else if (action === 'transfer') {
      if (!req.body.department?.trim()) throw new AppError('New department is required.', 422);
      employment.changes.push({ action: 'transfer', fromValue: employment.department, toValue: req.body.department.trim(), reason: req.body.reason || '', changedBy: req.user._id });
      employment.department = req.body.department.trim();
    } else if (action === 'contract') {
      employment.contractTerms = req.body.contractTerms ?? employment.contractTerms;
      employment.contractDocumentUrl = req.body.contractDocumentUrl ?? employment.contractDocumentUrl;
      employment.salaryType = req.body.salaryType || employment.salaryType;
      employment.commissionPercent = Number(req.body.commissionPercent ?? employment.commissionPercent);
    } else throw new AppError('Unsupported employment action.', 422);
  }
  await employment.save();
  await notify(employment.teacher, { title: `Employment updated at ${institution.name}`, body: action.replace('_', ' '), sentBy: req.user._id }).catch(() => {});
  return ok(res, employment, 'Employment updated.');
});
module.exports = { createOffer, respondToOffer, resign, terminate, updateEmployment, myEmployments, getContractLink, listInstitutionEmployments, listTeacherDirectory };
