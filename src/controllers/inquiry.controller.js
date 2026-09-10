const Inquiry = require('../models/Inquiry');
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

// POST /api/inquiries — a student expresses interest in a program.
const createInquiry = asyncHandler(async (req, res) => {
  const { institution, interestedProgram, qualification, country, message } = req.body;
  if (!institution || !interestedProgram) throw new AppError('institution and interestedProgram are required.', 422);

  const inst = await Institution.findById(institution);
  if (!inst) throw new AppError('Institution not found.', 404);

  const inquiry = await Inquiry.create({
    institution, student: req.user._id, interestedProgram,
    qualification: qualification || '', country: country || '', message: message || ''
  });

  // Notify every staff member + the owner — whoever picks it up first can assign themselves.
  const recipients = [inst.owner, ...inst.staff.map((s) => s.user)];
  await Promise.all(recipients.map((id) => notify(id, {
    title: `New inquiry: ${req.user.fullName} — ${interestedProgram}`,
    body: message || '',
    sentBy: req.user._id
  }).catch(() => {})));

  return created(res, inquiry, 'Inquiry submitted.');
});

// GET /api/inquiries/mine — the student's own inquiries.
const myInquiries = asyncHandler(async (req, res) => {
  const inquiries = await Inquiry.find({ student: req.user._id }).populate('institution', 'name').sort({ createdAt: -1 });
  return ok(res, inquiries);
});

// GET /api/inquiries/institution/:institutionId — representative/owner view.
const listInstitutionInquiries = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffOrOwner(institution, req.user._id);

  const inquiries = await Inquiry.find({ institution: institution._id })
    .populate('student', 'fullName email')
    .populate('assignedRepresentative', 'fullName')
    .sort({ createdAt: -1 });
  return ok(res, inquiries);
});

// PATCH /api/inquiries/:id — update status / assign representative.
const updateInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id).populate('institution');
  if (!inquiry) throw new AppError('Inquiry not found.', 404);
  assertStaffOrOwner(inquiry.institution, req.user._id);

  const { status, assignedRepresentative } = req.body;
  if (status !== undefined) {
    if (!['new', 'contacted', 'follow_up', 'resolved', 'closed'].includes(status)) throw new AppError('Invalid status.', 422);
    inquiry.status = status;
  }
  if (assignedRepresentative !== undefined) {
    inquiry.assignedRepresentative = assignedRepresentative || null;
    if (assignedRepresentative) {
      await notify(assignedRepresentative, {
        title: `New inquiry assigned: ${inquiry.interestedProgram}`,
        body: `${inquiry.institution.name}`,
        sentBy: req.user._id
      }).catch(() => {});
    }
  }
  await inquiry.save();
  return ok(res, inquiry, 'Inquiry updated.');
});

// POST /api/inquiries/:id/respond — representative replies; also marks status "contacted" if still "new".
const respondToInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id).populate('institution');
  if (!inquiry) throw new AppError('Inquiry not found.', 404);
  assertStaffOrOwner(inquiry.institution, req.user._id);

  const { text } = req.body;
  if (!text) throw new AppError('text is required.', 422);

  inquiry.responses.push({ by: req.user._id, text });
  if (inquiry.status === 'new') inquiry.status = 'contacted';
  await inquiry.save();

  await notify(inquiry.student, {
    title: `${inquiry.institution.name} responded to your inquiry`,
    body: text.slice(0, 140),
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, inquiry, 'Response sent.');
});

module.exports = { createInquiry, myInquiries, listInstitutionInquiries, updateInquiry, respondToInquiry };
