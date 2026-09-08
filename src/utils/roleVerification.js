const RoleRequest = require('../models/RoleRequest');

// Roles are granted immediately on request so the dashboard unlocks right away;
// "verified" (an approved RoleRequest) gates the sensitive, trust-affecting actions
// for that role (posting a job, a scholarship, a listing, publishing a course).
async function isRoleVerified(userId, role) {
  const approved = await RoleRequest.findOne({ user: userId, requestedRole: role, status: 'approved' });
  return Boolean(approved);
}

module.exports = { isRoleVerified };
