const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok, created } = require('../utils/apiResponse');
const Institution = require('../models/Institution');
const ClassSection = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const Result = require('../models/Result');
const StaffAttendance = require('../models/StaffAttendance');
const TeacherFeedback = require('../models/TeacherFeedback');
const Submission = require('../models/Submission');
const Assignment = require('../models/Assignment');
const LiveClassSession = require('../models/LiveClassSession');
const ParentChildLink = require('../models/ParentChildLink');
const StudentPromotion = require('../models/StudentPromotion');
const TeacherReview = require('../models/TeacherReview');
const { notify } = require('../services/notification.service');
const { recordLeave } = require('../utils/institutionMembership');
const { hasStaffPermission } = require('../utils/staffRoles');

// Bulk class promotion (spec 8.8) and teacher performance reviews (spec 8.9) for institutions.

const round1 = (n) => Math.round(n * 10) / 10;

async function institutionFor(req, ...permissions) {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (!hasStaffPermission(institution, req.user._id, ...permissions)) throw new AppError('You do not have permission to do this at this institution.', 403);
  if (institution.verificationStatus && institution.verificationStatus !== 'approved') throw new AppError('Your institution must be verified first.', 403);
  return institution;
}

async function sectionOf(institution, id, label) {
  const section = id && require('mongoose').isValidObjectId(id) ? await ClassSection.findOne({ _id: id, institution: institution._id }) : null;
  if (!section) throw new AppError(`Choose a ${label} class from this institution.`, 422);
  return section;
}

// Average % of each student's recorded results and attendance in a section's courses.
async function academicSummary(studentIds, courseIds) {
  const [results, attendance] = await Promise.all([
    Result.find({ student: { $in: studentIds }, course: { $in: courseIds } }).select('student marksObtained totalMarks').lean(),
    Attendance.find({ course: { $in: courseIds } }).select('records').lean()
  ]);
  const by = new Map(studentIds.map((id) => [String(id), { pct: [], present: 0, counted: 0 }]));
  for (const r of results) if (r.totalMarks > 0) by.get(String(r.student))?.pct.push((r.marksObtained / r.totalMarks) * 100);
  for (const a of attendance) for (const rec of a.records) {
    const row = by.get(String(rec.student));
    if (!row || rec.status === 'excused') continue;
    row.counted++;
    if (rec.status === 'present' || rec.status === 'late') row.present++;
    else if (rec.status === 'half_day') row.present += 0.5;
  }
  return by;
}

// GET /api/institutions/:id/promotions/preview?fromSection= — who is in the class, with their
// recorded average and attendance, to decide who moves up and who is held back.
const previewPromotion = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'students:manage');
  const from = await sectionOf(institution, req.query.fromSection, 'current');
  const profiles = await StudentProfile.find({ classSection: from._id, status: { $nin: ['graduated', 'transferred'] } }).populate('user', 'fullName email').lean();
  const courses = await Course.find({ institution: institution._id, classSection: from._id }).select('_id').lean();
  const summary = await academicSummary(profiles.map((p) => p.user?._id).filter(Boolean), courses.map((c) => c._id));
  return ok(res, {
    section: { _id: from._id, name: from.name, academicYear: from.academicYear },
    students: profiles.filter((p) => p.user).map((p) => {
      const s = summary.get(String(p.user._id));
      return {
        studentId: p.user._id, name: p.user.fullName, rollNumber: p.rollNumber || '', status: p.status || 'active',
        averagePercent: s.pct.length ? round1(s.pct.reduce((a, b) => a + b, 0) / s.pct.length) : null,
        attendancePercent: s.counted ? round1((s.present / s.counted) * 100) : null
      };
    }).sort((a, b) => a.name.localeCompare(b.name))
  });
});

// POST /api/institutions/:id/promotions — { action: 'promote'|'graduate', fromSection, toSection,
// heldBack: [{ student, reason }], note }. Moves everyone else, records it, tells families.
const promote = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'students:manage');
  const { action = 'promote', fromSection, toSection, heldBack = [], note = '' } = req.body;
  if (!['promote', 'graduate'].includes(action)) throw new AppError('action must be promote or graduate.', 422);
  const from = await sectionOf(institution, fromSection, 'current');
  const to = action === 'promote' ? await sectionOf(institution, toSection, 'next') : null;
  if (to && String(to._id) === String(from._id)) throw new AppError('Choose a different class to promote into.', 422);
  if (!Array.isArray(heldBack)) throw new AppError('heldBack must be a list.', 422);
  const held = new Map(heldBack.filter((h) => h?.student).map((h) => [String(h.student), String(h.reason || '').trim().slice(0, 300)]));

  const profiles = await StudentProfile.find({ classSection: from._id, status: { $nin: ['graduated', 'transferred'] } });
  for (const id of held.keys()) if (!profiles.some((p) => String(p.user) === id)) throw new AppError('A held-back student is not in this class.', 422);
  const moving = profiles.filter((p) => !held.has(String(p.user)));
  if (!moving.length) throw new AppError('Nobody left to move: everyone in this class is held back.', 422);

  const [fromCourses, toCourses] = await Promise.all([
    Course.find({ institution: institution._id, classSection: from._id }).select('_id').lean(),
    to ? Course.find({ institution: institution._id, classSection: to._id, published: true }).select('_id').lean() : []
  ]);
  const movingIds = moving.map((p) => p.user);
  // Last year's courses close as completed (history and results stay); next year's open.
  await Enrollment.updateMany({ student: { $in: movingIds }, course: { $in: fromCourses.map((c) => c._id) }, status: 'active' }, { $set: { status: 'completed' } });
  for (const profile of moving) {
    if (to) {
      profile.classSection = to._id;
      await profile.save();
      await Enrollment.bulkWrite(toCourses.map((c) => ({ updateOne: { filter: { student: profile.user, course: c._id }, update: { $setOnInsert: { student: profile.user, course: c._id } }, upsert: true } })));
    } else {
      profile.status = 'graduated';
      await profile.save();
      await recordLeave(profile.user, institution._id, 'graduated', note || `Graduated from ${from.name}`);
    }
  }

  const record = await StudentPromotion.create({ institution: institution._id, action, fromSection: from._id, toSection: to?._id || null, moved: movingIds, heldBack: [...held].map(([student, reason]) => ({ student, reason })), note: String(note).slice(0, 500), by: req.user._id });

  const tell = async (studentId, title, body) => {
    const parents = await ParentChildLink.find({ student: studentId, status: 'approved' }).distinct('parent');
    for (const userId of [studentId, ...parents]) await notify(userId, { title, body, sentBy: req.user._id }).catch(() => {});
  };
  for (const id of movingIds) await tell(id, action === 'promote' ? `Promoted to ${to.name}` : `Graduated from ${institution.name}`, action === 'promote' ? `${institution.name} moved the class ${from.name} up to ${to.name}.` : `Congratulations on completing ${from.name}.`);
  for (const [id, reason] of held) await tell(id, `Staying in ${from.name}`, `${institution.name} is keeping this student in ${from.name}${reason ? `: ${reason}` : '.'}`);

  return created(res, record, action === 'promote' ? `${movingIds.length} student(s) promoted to ${to.name}.` : `${movingIds.length} student(s) graduated.`);
});

// GET /api/institutions/:id/promotions — history.
const listPromotions = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'students:manage');
  const rows = await StudentPromotion.find({ institution: institution._id }).populate('fromSection toSection', 'name academicYear').populate('by', 'fullName').populate('heldBack.student', 'fullName').sort({ createdAt: -1 }).limit(50).lean();
  return ok(res, rows.map((r) => ({ ...r, movedCount: r.moved.length, moved: undefined })));
});

// ---------------------------------------------------------------- Teacher performance reviews

async function teacherAt(institution, teacherId) {
  const staff = institution.staff.find((s) => String(s.user) === String(teacherId) && s.role === 'teacher');
  if (!staff) throw new AppError('That person is not a teacher at this institution.', 404);
  return staff;
}

// The teacher's record at this institution, which the reviewer sees beside the form.
async function evidenceFor(institution, teacherId) {
  const courses = await Course.find({ institution: institution._id, teacher: teacherId }).select('_id title').lean();
  const courseIds = courses.map((c) => c._id);
  const [checkIns, late, ratings, results, assignments, attendanceMarked, liveClasses] = await Promise.all([
    StaffAttendance.countDocuments({ institution: institution._id, staff: teacherId }),
    StaffAttendance.countDocuments({ institution: institution._id, staff: teacherId, status: 'late' }),
    TeacherFeedback.aggregate([{ $match: { teacher: new (require('mongoose').Types.ObjectId)(String(teacherId)), institution: institution._id, hidden: { $ne: true } } }, { $group: { _id: '$fromRole', average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
    Result.find({ course: { $in: courseIds } }).select('marksObtained totalMarks').lean(),
    Assignment.find({ course: { $in: courseIds } }).select('_id').lean(),
    Attendance.countDocuments({ course: { $in: courseIds }, markedBy: teacherId }),
    LiveClassSession.countDocuments({ teacher: teacherId, course: { $in: courseIds }, status: 'ended' })
  ]);
  const graded = assignments.length ? await Submission.countDocuments({ assignment: { $in: assignments.map((a) => a._id) }, status: 'graded' }) : 0;
  const pct = results.filter((r) => r.totalMarks > 0).map((r) => (r.marksObtained / r.totalMarks) * 100);
  return {
    courses: courses.map((c) => c.title),
    checkIns, lateCheckIns: late,
    ratings: Object.fromEntries(ratings.map((r) => [r._id, { average: round1(r.average), count: r.count }])),
    classResults: { count: pct.length, averagePercent: pct.length ? round1(pct.reduce((a, b) => a + b, 0) / pct.length) : null },
    assignmentsSet: assignments.length, submissionsGraded: graded, classesWithAttendance: attendanceMarked, liveClasses
  };
}

// GET /api/institutions/:id/review-teachers — the institution's teachers with their latest review.
const listReviewTeachers = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'staff:review');
  const ids = institution.staff.filter((s) => s.role === 'teacher').map((s) => s.user);
  const [users, reviews] = await Promise.all([
    require('../models/User').find({ _id: { $in: ids } }).select('fullName profilePhoto').lean(),
    TeacherReview.find({ institution: institution._id, teacher: { $in: ids } }).select('teacher period overall status acknowledgedAt createdAt').sort({ createdAt: -1 }).lean()
  ]);
  return ok(res, users.map((user) => ({ ...user, latestReview: reviews.find((r) => String(r.teacher) === String(user._id)) || null })).sort((a, b) => a.fullName.localeCompare(b.fullName)));
});

// GET /api/institutions/:id/teachers/:teacherId/review-data
const reviewData = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'staff:review');
  await teacherAt(institution, req.params.teacherId);
  const reviews = await TeacherReview.find({ institution: institution._id, teacher: req.params.teacherId }).populate('reviewer', 'fullName').sort({ createdAt: -1 }).lean();
  return ok(res, { evidence: await evidenceFor(institution, req.params.teacherId), reviews });
});

const REVIEW_FIELDS = ['period', 'ratings', 'strengths', 'improvements', 'goals'];

// POST /api/institutions/:id/teachers/:teacherId/reviews — a draft review.
const createReview = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'staff:review');
  await teacherAt(institution, req.params.teacherId);
  if (String(req.params.teacherId) === String(req.user._id)) throw new AppError('You cannot review yourself.', 403);
  const body = Object.fromEntries(REVIEW_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]]));
  try {
    const review = await TeacherReview.create({ ...body, institution: institution._id, teacher: req.params.teacherId, reviewer: req.user._id });
    return created(res, review, 'Review saved as a draft.');
  } catch (e) {
    if (e.code === 11000) throw new AppError('This teacher already has a review for that period.', 409);
    if (e.name === 'ValidationError') throw new AppError('Rate every area from 1 to 5 and give the review period.', 422);
    throw e;
  }
});

// PATCH /api/institutions/:id/reviews/:reviewId — edit a draft, or { share: true } to share it.
const updateReview = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'staff:review');
  const review = await TeacherReview.findOne({ _id: req.params.reviewId, institution: institution._id });
  if (!review) throw new AppError('Review not found.', 404);
  if (review.status === 'shared') throw new AppError('A shared review cannot be changed.', 409);
  for (const f of REVIEW_FIELDS) if (req.body[f] !== undefined) review[f] = f === 'ratings' ? { ...review.ratings?.toObject?.() ?? review.ratings, ...req.body.ratings } : req.body[f];
  if (req.body.share === true) {
    review.status = 'shared';
    review.sharedAt = new Date();
    review.evidence = await evidenceFor(institution, review.teacher);
  }
  try { await review.save(); } catch (e) { if (e.name === 'ValidationError') throw new AppError('Rate every area from 1 to 5 and give the review period.', 422); throw e; }
  if (review.status === 'shared' && req.body.share === true) await notify(review.teacher, { title: `Performance review from ${institution.name}`, body: `${review.period}: overall ${review.overall} / 5. Read it and add your response from your dashboard.`, sentBy: req.user._id }).catch(() => {});
  return ok(res, review, review.status === 'shared' ? 'Review shared with the teacher.' : 'Draft updated.');
});

// GET /api/institutions/teacher-reviews/mine — a teacher's own shared reviews.
const myReviews = asyncHandler(async (req, res) => {
  const rows = await TeacherReview.find({ teacher: req.user._id, status: 'shared' }).populate('institution', 'name').populate('reviewer', 'fullName').sort({ sharedAt: -1 }).lean();
  return ok(res, rows);
});

// POST /api/institutions/teacher-reviews/:reviewId/respond — the teacher acknowledges and responds.
const respondToReview = asyncHandler(async (req, res) => {
  const review = await TeacherReview.findOne({ _id: req.params.reviewId, teacher: req.user._id, status: 'shared' });
  if (!review) throw new AppError('Review not found.', 404);
  review.teacherResponse = String(req.body.response || '').trim().slice(0, 2000);
  review.acknowledgedAt = new Date();
  await review.save();
  const institution = await Institution.findById(review.institution).select('owner name');
  for (const userId of new Set([String(review.reviewer), String(institution?.owner)])) await notify(userId, { title: `${req.user.fullName} responded to their review`, body: review.period, sentBy: req.user._id }).catch(() => {});
  return ok(res, review, 'Response saved.');
});

module.exports = { previewPromotion, promote, listPromotions, listReviewTeachers, reviewData, createReview, updateReview, myReviews, respondToReview };
