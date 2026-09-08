const ParentChildLink = require('../models/ParentChildLink');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Result = require('../models/Result');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// POST /api/parents/link-requests - parent requests to link a student by email
const requestLink = asyncHandler(async (req, res) => {
  const { studentEmail, relationship } = req.body;
  if (!studentEmail) throw new AppError('studentEmail is required.', 422);

  const student = await User.findOne({ email: studentEmail.toLowerCase() });
  if (!student) throw new AppError('No user found with that email.', 404);
  if (!student.roles.includes('student')) throw new AppError('That account is not a student account.', 400);

  const existing = await ParentChildLink.findOne({ parent: req.user._id, student: student._id });
  if (existing) throw new AppError('A link request already exists for this student.', 409);

  const link = await ParentChildLink.create({
    parent: req.user._id,
    student: student._id,
    relationship: relationship || 'guardian',
    requestedBy: req.user._id
  });

  return created(res, link, 'Link request sent. Awaiting student/institution approval.');
});

// GET /api/parents/children - approved links only
const myChildren = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' })
    .populate('student', 'fullName email');
  return ok(res, links);
});

// GET /api/parents/link-requests - all of my requests (any status)
const myLinkRequests = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id }).populate('student', 'fullName email');
  return ok(res, links);
});

// GET /api/parents/incoming-requests - requests where the current user is the student being linked
const incomingRequests = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ student: req.user._id, status: 'pending' })
    .populate('parent', 'fullName email');
  return ok(res, links);
});

// PATCH /api/parents/link-requests/:id/respond - the student approves/rejects
const respondToLink = asyncHandler(async (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('Decision must be approved or rejected.', 422);

  const link = await ParentChildLink.findById(req.params.id);
  if (!link) throw new AppError('Link request not found.', 404);
  if (link.student.toString() !== req.user._id.toString()) {
    throw new AppError('Only the student can respond to this request.', 403);
  }
  if (link.status !== 'pending') throw new AppError('This request has already been responded to.', 400);

  link.status = decision;
  if (decision === 'approved') link.approvedAt = new Date();
  await link.save();

  return ok(res, link, `Link request ${decision}.`);
});

function assertApprovedLink(links, studentId) {
  const found = links.find((l) => l.student.toString() === studentId);
  if (!found) throw new AppError('You are not linked to this student.', 403);
}

// GET /api/parents/children/:studentId/attendance
const childAttendance = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const records = await Attendance.find({ 'records.student': req.params.studentId }).sort({ date: -1 });
  return ok(res, records);
});

// GET /api/parents/children/:studentId/results
const childResults = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' });
  assertApprovedLink(links, req.params.studentId);

  const results = await Result.find({ student: req.params.studentId }).sort({ createdAt: -1 });
  return ok(res, results);
});

module.exports = {
  requestLink,
  myChildren,
  myLinkRequests,
  incomingRequests,
  respondToLink,
  childAttendance,
  childResults
};
