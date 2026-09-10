const VirtualFair = require('../models/VirtualFair');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

function assertStaffOrOwner(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You are not staff at this institution.', 403);
}

// GET /api/virtual-fairs — public browse of upcoming fairs (any institution).
const listFairs = asyncHandler(async (req, res) => {
  const fairs = await VirtualFair.find({ scheduledDate: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } })
    .populate('institution', 'name logo')
    .sort({ scheduledDate: 1 });
  return ok(res, fairs);
});

// POST /api/virtual-fairs — representative/owner creates a fair "booth".
const createFair = asyncHandler(async (req, res) => {
  const { institution, title, description, scheduledDate, videoCallLink, brochureUrl } = req.body;
  if (!institution || !title || !scheduledDate) throw new AppError('institution, title and scheduledDate are required.', 422);

  const inst = await Institution.findById(institution);
  if (!inst) throw new AppError('Institution not found.', 404);
  assertStaffOrOwner(inst, req.user._id);

  const fair = await VirtualFair.create({
    institution, title, description: description || '', scheduledDate,
    videoCallLink: videoCallLink || '', brochureUrl: brochureUrl || ''
  });
  return created(res, fair, 'Virtual fair created.');
});

// GET /api/virtual-fairs/institution/:institutionId — representative view (with registrant list).
const listInstitutionFairs = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffOrOwner(institution, req.user._id);

  const fairs = await VirtualFair.find({ institution: institution._id })
    .populate('registeredStudents', 'fullName email')
    .sort({ scheduledDate: -1 });
  return ok(res, fairs);
});

// POST /api/virtual-fairs/:id/register — a student registers for a fair.
const registerForFair = asyncHandler(async (req, res) => {
  const fair = await VirtualFair.findById(req.params.id);
  if (!fair) throw new AppError('Fair not found.', 404);

  if (!fair.registeredStudents.some((s) => s.toString() === req.user._id.toString())) {
    fair.registeredStudents.push(req.user._id);
    await fair.save();
  }
  return ok(res, fair, 'Registered for the fair.');
});

// GET /api/virtual-fairs/mine/registered — student's own registered fairs.
const myRegisteredFairs = asyncHandler(async (req, res) => {
  const fairs = await VirtualFair.find({ registeredStudents: req.user._id })
    .populate('institution', 'name logo')
    .sort({ scheduledDate: 1 });
  return ok(res, fairs);
});

module.exports = { listFairs, createFair, listInstitutionFairs, registerForFair, myRegisteredFairs };
