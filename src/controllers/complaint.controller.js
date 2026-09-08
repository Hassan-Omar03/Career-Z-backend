const Complaint = require('../models/Complaint');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// POST /api/complaints
const createComplaint = asyncHandler(async (req, res) => {
  const { subject, category, description, targetType, targetId } = req.body;
  if (!subject || !description) throw new AppError('subject and description are required.', 422);

  const complaint = await Complaint.create({
    submittedBy: req.user._id,
    subject,
    category: category || 'other',
    description,
    targetType: targetType || 'none',
    targetId: targetId || null
  });

  return created(res, complaint, 'Complaint submitted.');
});

// GET /api/complaints/mine
const myComplaints = asyncHandler(async (req, res) => {
  const complaints = await Complaint.find({ submittedBy: req.user._id }).sort({ createdAt: -1 });
  return ok(res, complaints);
});

// GET /api/complaints (admin)
const listComplaints = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;
  const complaints = await Complaint.find(filter)
    .populate('submittedBy', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, complaints);
});

// PATCH /api/complaints/:id (admin)
const updateComplaintStatus = asyncHandler(async (req, res) => {
  const { status, resolutionNotes } = req.body;
  if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) throw new AppError('Complaint not found.', 404);

  complaint.status = status;
  complaint.resolutionNotes = resolutionNotes || complaint.resolutionNotes;
  if (status === 'resolved' || status === 'dismissed') {
    complaint.resolvedBy = req.user._id;
    complaint.resolvedAt = new Date();
  }
  await complaint.save();
  return ok(res, complaint, `Complaint ${status}.`);
});

module.exports = { createComplaint, myComplaints, listComplaints, updateComplaintStatus };
