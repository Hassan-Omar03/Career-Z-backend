const mongoose = require('mongoose');
const LiveClassSession = require('../models/LiveClassSession');
const Attendance = require('../models/Attendance');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const TeacherFeedback = require('../models/TeacherFeedback');
const TeacherProfile = require('../models/TeacherProfile');
const RoleRequest = require('../models/RoleRequest');

// Verified teaching hours and the Bronze / Silver / Gold / Verified Expert badges (master spec
// 9.19 and "Teacher Verification Badge"). Everything comes from records CareerZ itself holds:
// live classes that actually ran here (real start and end times), classes with attendance
// marked, real enrolments and verified ratings. Nothing a teacher types in counts toward a badge.

const MAX_SESSION_HOURS = 6; // a session left open overnight never counts as a full day of teaching

const BADGES = [
  { key: 'bronze', label: 'Bronze', needs: { hours: 10, reviews: 3, rating: 3.5, students: 5 } },
  { key: 'silver', label: 'Silver', needs: { hours: 50, reviews: 10, rating: 4.0, students: 20 } },
  { key: 'gold', label: 'Gold', needs: { hours: 200, reviews: 25, rating: 4.5, students: 50 } },
  { key: 'expert', label: 'Verified Expert', needs: { hours: 500, reviews: 50, rating: 4.7, students: 100, experienceYears: 5 } }
];

function meets(stats, needs) {
  return stats.approved
    && stats.verifiedHours >= needs.hours
    && stats.reviews.count >= needs.reviews
    && (stats.reviews.average || 0) >= needs.rating
    && stats.studentsTaught >= needs.students
    && (!needs.experienceYears || stats.experienceYears >= needs.experienceYears);
}

function missing(stats, needs) {
  const out = [];
  if (!stats.approved) out.push('Get your teacher account verified by CareerZ');
  if (stats.verifiedHours < needs.hours) out.push(`${Math.ceil(needs.hours - stats.verifiedHours)} more verified teaching hours`);
  if (stats.reviews.count < needs.reviews) out.push(`${needs.reviews - stats.reviews.count} more verified ratings`);
  if ((stats.reviews.average || 0) < needs.rating) out.push(`an average rating of ${needs.rating} or higher`);
  if (stats.studentsTaught < needs.students) out.push(`${needs.students - stats.studentsTaught} more students taught`);
  if (needs.experienceYears && stats.experienceYears < needs.experienceYears) out.push(`${needs.experienceYears} years of experience`);
  return out;
}

async function standingFor(teacherId) {
  const id = new mongoose.Types.ObjectId(String(teacherId));
  const [sessions, attendanceClasses, courses, ratings, profile, approved] = await Promise.all([
    LiveClassSession.find({ teacher: id, status: 'ended', startedAt: { $ne: null }, endedAt: { $ne: null } }).select('startedAt endedAt').lean(),
    Attendance.countDocuments({ markedBy: id }),
    Course.find({ teacher: id }).select('_id').lean(),
    TeacherFeedback.aggregate([{ $match: { teacher: id } }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
    TeacherProfile.findOne({ user: id }).select('experienceYears').lean(),
    RoleRequest.exists({ user: id, requestedRole: 'teacher', status: 'approved' })
  ]);
  const verifiedHours = Math.round(sessions.reduce((sum, s) => sum + Math.min(MAX_SESSION_HOURS, Math.max(0, (new Date(s.endedAt) - new Date(s.startedAt)) / 36e5)), 0) * 10) / 10;
  const studentsTaught = courses.length ? (await Enrollment.distinct('student', { course: { $in: courses.map((c) => c._id) }, status: { $ne: 'dropped' } })).length : 0;
  const stats = {
    approved: Boolean(approved),
    verifiedHours,
    liveClasses: sessions.length,
    classesWithAttendance: attendanceClasses,
    studentsTaught,
    reviews: { average: ratings[0] ? Math.round(ratings[0].average * 10) / 10 : null, count: ratings[0]?.count || 0 },
    experienceYears: profile?.experienceYears || 0
  };
  const earned = BADGES.filter((b) => meets(stats, b.needs));
  const badge = earned.length ? earned[earned.length - 1] : null;
  const next = BADGES[earned.length] || null;
  return {
    ...stats,
    badge: badge ? { key: badge.key, label: badge.label } : null,
    next: next ? { key: next.key, label: next.label, needs: missing(stats, next.needs) } : null,
    rules: BADGES.map((b) => ({ key: b.key, label: b.label, ...b.needs }))
  };
}

module.exports = { standingFor, BADGES };
