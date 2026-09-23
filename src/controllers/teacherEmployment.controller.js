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

function assertOwner(institution, userId) {
  if (institution.owner.toString() !== userId.toString()) throw new AppError('Only the institution owner can manage hiring.', 403);
}

// POST /api/institutions/:id/teacher-offers — the real, consent-based alternative to directly
// adding staff (spec: Teacher<->Institution "hiring application/offer/acceptance, employment
// contract"). Nothing changes on the institution or the teacher's account until they accept.
const createOffer = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);

  const { teacherUserId, role, designation, department, contractTerms } = req.body;
  if (!teacherUserId || !role) throw new AppError('teacherUserId and role are required.', 422);
  const teacher = await User.findById(teacherUserId);
  if (!teacher) throw new AppError('Teacher not found.', 404);
  if (institution.staff.some((s) => s.user.toString() === teacherUserId)) {
    throw new AppError('This person is already staff at this institution.', 409);
  }
  await assertStaffCapAllows(institution, institution.staff.length);

  const offer = await TeacherEmployment.create({
    teacher: teacherUserId, institution: institution._id, role,
    designation: designation || '', department: department || '', contractTerms: contractTerms || '',
    status: 'offered', offeredBy: req.user._id
  });

  await notify(teacherUserId, {
    title: `Job offer from ${institution.name}`,
    body: `Role: ${role}${designation ? ` (${designation})` : ''}. Review and respond from Employment Offers.`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, offer, 'Offer sent.');
});

// GET /api/institutions/:id/teacher-directory — lets an institution browse teachers to hire,
// instead of needing to already know a teacher's exact User ID (which used to be the only way
// to send an offer). Only professional info is exposed here (no email/phone/address) — contact
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

// PATCH /api/teacher-employments/:id/respond — the teacher accepts or declines. Accepting is
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

// POST /api/teacher-employments/:id/resign — teacher-initiated departure.
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

// PATCH /api/teacher-employments/:id/terminate — institution-initiated departure.
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

// GET /api/teacher-employments/mine — a teacher's full service history, every institution.
const myEmployments = asyncHandler(async (req, res) => {
  const employments = await TeacherEmployment.find({ teacher: req.user._id })
    .populate('institution', 'name type country logo')
    .sort({ createdAt: -1 });
  return ok(res, employments);
});

// GET /api/institutions/:id/teacher-employments — the institution's own hiring history.
const listInstitutionEmployments = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwner(institution, req.user._id);

  const employments = await TeacherEmployment.find({ institution: institution._id })
    .populate('teacher', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, employments);
});

module.exports = { createOffer, respondToOffer, resign, terminate, myEmployments, listInstitutionEmployments, listTeacherDirectory };
