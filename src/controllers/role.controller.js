const RoleRequest = require('../models/RoleRequest');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { ROLES, APPROVAL_REQUIRED_ROLES } = require('../config/rbac');
const { emitToUser } = require('../realtime/socket');

// POST /api/roles/request
// The role (and its dashboard) is granted immediately so the user isn't stuck
// looking at the Student workspace while waiting on review. For roles that need
// vetting, an approved RoleRequest is still required before sensitive actions
// (posting a job/scholarship/listing, publishing a course) are allowed — see
// utils/roleVerification.js — and a rejection revokes the role again.
const requestRole = asyncHandler(async (req, res) => {
  const { requestedRole, documents, notes } = req.body;

  if (!ROLES.includes(requestedRole)) throw new AppError('Unknown role requested.', 422);
  if (requestedRole === 'super_admin' || requestedRole === 'admin' || requestedRole === 'platform_staff') {
    throw new AppError('This role cannot be self-requested.', 403);
  }
  if (req.user.roles.includes(requestedRole)) {
    throw new AppError('You already have this role.', 400);
  }

  req.user.roles = Array.from(new Set([...req.user.roles, requestedRole]));
  await req.user.save();

  if (!APPROVAL_REQUIRED_ROLES.includes(requestedRole)) {
    return ok(res, { user: req.user.toSafeJSON() }, 'Role granted immediately.');
  }

  const existingPending = await RoleRequest.findOne({
    user: req.user._id,
    requestedRole,
    status: { $in: ['pending', 'under_review'] }
  });
  if (existingPending) {
    return ok(res, { user: req.user.toSafeJSON(), request: existingPending }, 'Dashboard unlocked. Verification is already pending.');
  }

  const request = await RoleRequest.create({
    user: req.user._id,
    requestedRole,
    documents: documents || [],
    notes: notes || ''
  });

  emitToUser(req.user._id, 'dashboard:update', { reason: 'role-request-created' });

  return created(res, { user: req.user.toSafeJSON(), request }, 'Dashboard unlocked. Verification is pending before you can post.');
});

// GET /api/roles/my-requests
const myRequests = asyncHandler(async (req, res) => {
  const requests = await RoleRequest.find({ user: req.user._id }).sort({ createdAt: -1 });
  return ok(res, requests);
});

// GET /api/roles/pending (admin)
const pendingRequests = asyncHandler(async (req, res) => {
  const requests = await RoleRequest.find({ status: { $in: ['pending', 'under_review'] } })
    .populate('user', 'fullName email roles')
    .sort({ createdAt: 1 });
  return ok(res, requests);
});

// PATCH /api/roles/:id/review (admin)
const reviewRequest = asyncHandler(async (req, res) => {
  const { decision, reviewNotes } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    throw new AppError('Decision must be approved or rejected.', 422);
  }

  const request = await RoleRequest.findById(req.params.id);
  if (!request) throw new AppError('Role request not found.', 404);
  if (request.status === 'approved' || request.status === 'rejected') {
    throw new AppError('This request has already been reviewed.', 400);
  }

  request.status = decision;
  request.reviewedBy = req.user._id;
  request.reviewNotes = reviewNotes || '';
  request.reviewedAt = new Date();
  await request.save();

  const user = await User.findById(request.user);
  if (decision === 'approved') {
    user.roles = Array.from(new Set([...user.roles, request.requestedRole]));
  } else {
    // Rejection revokes the provisional dashboard access granted at request time.
    user.roles = user.roles.filter((r) => r !== request.requestedRole);
  }
  await user.save();

  emitToUser(request.user, 'dashboard:update', { reason: 'role-request-reviewed', decision });

  return ok(res, request, `Role request ${decision}.`);
});

module.exports = { requestRole, myRequests, pendingRequests, reviewRequest };
