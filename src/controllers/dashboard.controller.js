const RoleRequest = require('../models/RoleRequest');
const Enrollment = require('../models/Enrollment');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// GET /api/dashboard/summary — every number here is computed from real documents,
// never hardcoded, so it changes the moment the user's data changes.
const summary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [roleRequests, enrollments] = await Promise.all([
    RoleRequest.find({ user: userId }).sort({ updatedAt: -1 }),
    Enrollment.find({ student: userId }).populate('course', 'title subject').sort({ updatedAt: -1 })
  ]);

  const activeApplications = roleRequests.filter((r) => ['pending', 'under_review'].includes(r.status)).length;
  const enrolledCourses = enrollments.filter((e) => e.status === 'active').length;
  const approvedRequests = roleRequests.filter((r) => r.status === 'approved').length;

  const stats = [
    { key: 'applications', icon: '▤', num: activeApplications, label: 'Active Applications' },
    { key: 'courses', icon: '▥', num: enrolledCourses, label: 'Enrolled Courses' },
    { key: 'approved', icon: '✓', num: approvedRequests, label: 'Approved Requests' },
    { key: 'total', icon: '▧', num: roleRequests.length + enrollments.length, label: 'Total Activity' }
  ];

  const roleRequestEvents = roleRequests.map((r) => ({
    id: `role-${r._id}`,
    title:
      r.status === 'approved'
        ? `Role request approved: ${r.requestedRole}`
        : r.status === 'rejected'
        ? `Role request rejected: ${r.requestedRole}`
        : `Role request submitted: ${r.requestedRole}`,
    desc: r.reviewNotes || r.notes || 'No additional notes.',
    time: r.updatedAt,
    status: r.status
  }));

  const enrollmentEvents = enrollments.map((e) => ({
    id: `enroll-${e._id}`,
    title: `Enrolled in "${e.course?.title || 'a course'}"`,
    desc: e.course?.subject || '',
    time: e.updatedAt,
    status: e.status
  }));

  const recentActivity = [...roleRequestEvents, ...enrollmentEvents]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 10);

  const user = req.user;
  const profileChecks = [
    { ok: !!user.fullName, label: 'Basic details added' },
    { ok: !!user.emailVerified, label: 'Email verified' },
    { ok: !!user.profilePhoto, label: 'Add profile photo' },
    { ok: !!user.phone, label: 'Add phone number' }
  ];
  const profilePercent = Math.round((profileChecks.filter((c) => c.ok).length / profileChecks.length) * 100);

  return ok(res, {
    stats,
    recentActivity,
    profile: { percent: profilePercent, checks: profileChecks },
    recommended: enrollments.length === 0
      ? []
      : enrollments.slice(0, 3).map((e) => ({
          title: e.course?.title || 'Course',
          meta: e.course?.subject || '',
          tag: e.status
        }))
  });
});

module.exports = { summary };
