const mongoose = require('mongoose');
const TeacherFeedback = require('../models/TeacherFeedback');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const ParentChildLink = require('../models/ParentChildLink');
const Institution = require('../models/Institution');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

// Verifies the caller actually has a real relationship with this teacher (no fake/self-serve
// ratings) — tried in order: real enrollment under the teacher, a linked child enrolled under
// the teacher, or being the owner/staff of an institution the teacher actually works at.
// Returns { fromRole, institution } for the first real relationship found, or null.
async function determineRaterContext(teacherId, user) {
  const teacherCourses = await Course.find({ teacher: teacherId }).select('_id');
  const courseIds = teacherCourses.map((c) => c._id);

  if (courseIds.length && await Enrollment.exists({ student: user._id, course: { $in: courseIds } })) {
    return { fromRole: 'student', institution: null };
  }

  if (courseIds.length) {
    const links = await ParentChildLink.find({ parent: user._id, status: 'approved' }).select('student');
    const childIds = links.map((l) => l.student);
    if (childIds.length && await Enrollment.exists({ student: { $in: childIds }, course: { $in: courseIds } })) {
      return { fromRole: 'parent', institution: null };
    }
  }

  const institutions = await Institution.find({ 'staff.user': teacherId });
  for (const inst of institutions) {
    const isOwner = inst.owner.toString() === user._id.toString();
    const isStaff = inst.staff.some((s) => s.user.toString() === user._id.toString());
    if (isOwner || isStaff) return { fromRole: 'institution', institution: inst._id };
  }

  return null;
}

// POST /api/teacher-feedback/:teacherId — rating is only accepted from a verified relationship
// (real class/child link, or being the teacher's actual institution). Submitting again from the
// same relationship updates the existing rating instead of creating a duplicate.
const submitFeedback = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) throw new AppError('rating must be between 1 and 5.', 422);

  const teacher = await User.findById(req.params.teacherId);
  if (!teacher || !teacher.roles.includes('teacher')) throw new AppError('Teacher not found.', 404);
  if (teacher._id.toString() === req.user._id.toString()) throw new AppError('You cannot rate yourself.', 400);

  const context = await determineRaterContext(teacher._id, req.user);
  if (!context) throw new AppError('You can only rate a teacher you have a real class, child or institution relationship with.', 403);

  const feedback = await TeacherFeedback.findOneAndUpdate(
    { teacher: teacher._id, fromUser: req.user._id, institution: context.institution },
    { teacher: teacher._id, fromUser: req.user._id, fromRole: context.fromRole, institution: context.institution, rating, comment: comment || '' },
    { upsert: true, new: true, runValidators: true }
  );

  await notify(teacher._id, { title: `New ${context.fromRole} rating: ★ ${rating}`, body: comment || '', sentBy: req.user._id }).catch(() => {});

  return created(res, feedback, 'Feedback submitted.');
});

// GET /api/teacher-feedback/:teacherId — public reputation summary + recent comments, shown on
// the teacher's profile (spec: teacher rating/reputation across Student/Parent/Institution).
const getTeacherReputation = asyncHandler(async (req, res) => {
  const [agg, recent] = await Promise.all([
    TeacherFeedback.aggregate([
      { $match: { teacher: new mongoose.Types.ObjectId(req.params.teacherId) } },
      { $group: { _id: '$fromRole', average: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]),
    TeacherFeedback.find({ teacher: req.params.teacherId, comment: { $ne: '' } })
      .populate('fromUser', 'fullName')
      .sort({ createdAt: -1 })
      .limit(20)
  ]);

  const byRole = Object.fromEntries(agg.map((a) => [a._id, { average: Math.round(a.average * 10) / 10, count: a.count }]));
  const totalCount = agg.reduce((sum, a) => sum + a.count, 0);
  const overallAverage = totalCount > 0
    ? Math.round((agg.reduce((sum, a) => sum + a.average * a.count, 0) / totalCount) * 10) / 10
    : null;

  return ok(res, { overallAverage, totalCount, byRole, recent });
});

module.exports = { submitFeedback, getTeacherReputation };
