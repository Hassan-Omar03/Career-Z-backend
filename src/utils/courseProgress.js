// Single source of truth for "how far along is this student in this course" — deliberately
// separates two different questions the old code conflated into one field:
//   - Lesson progress  (enrollment.progressPercent): how much of the material was gone through.
//   - Course completion (enrollment.overallScore / completionStatus): a weighted composite of
//     lessons + graded assignments + graded tests + attendance, using the course's own
//     completionRules — so a 1-lesson course marking that lesson done no longer reads as
//     "the whole course is finished."
// Called from every place that changes one of those four inputs (course.controller.js's
// completeLesson/gradeSubmission/gradeExamSubmission/addLesson/createAssignment/publishExam, and
// every attendance-marking call site in teacher/student/webauthn controllers) so the stored
// numbers never go stale relative to what a live query would show.
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Lesson = require('../models/Lesson');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Exam = require('../models/Exam');
const ExamSubmission = require('../models/ExamSubmission');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { getBlockingInstitutionFee } = require('./feeAccess');
const { notify } = require('../services/notification.service');

const DEFAULT_WEIGHTS = { lessons: 40, assignments: 20, tests: 25, attendance: 15 };

async function computeComponents(studentId, courseId) {
  const totalLessons = await Lesson.countDocuments({ course: courseId });
  const completedLessonsCount = (await Enrollment.findOne({ student: studentId, course: courseId }).select('completedLessons'))?.completedLessons.length || 0;
  const lessonsPct = totalLessons > 0 ? (completedLessonsCount / totalLessons) * 100 : 0;

  const assignmentIds = (await Assignment.find({ course: courseId }).select('_id')).map((a) => a._id);
  const totalAssignments = assignmentIds.length;
  const gradedAssignments = totalAssignments > 0
    ? await Submission.countDocuments({ assignment: { $in: assignmentIds }, student: studentId, status: 'graded' })
    : 0;
  const assignmentsPct = totalAssignments > 0 ? (gradedAssignments / totalAssignments) * 100 : 0;

  const examIds = (await Exam.find({ course: courseId, published: true }).select('_id')).map((e) => e._id);
  const totalExams = examIds.length;
  const gradedExams = totalExams > 0
    ? await ExamSubmission.countDocuments({ exam: { $in: examIds }, student: studentId, status: 'graded' })
    : 0;
  const testsPct = totalExams > 0 ? (gradedExams / totalExams) * 100 : 0;

  const totalSessions = await Attendance.countDocuments({ course: courseId });
  const attendedSessions = totalSessions > 0
    ? await Attendance.countDocuments({ course: courseId, records: { $elemMatch: { student: studentId, status: { $in: ['present', 'late'] } } } })
    : 0;
  const attendancePct = totalSessions > 0 ? (attendedSessions / totalSessions) * 100 : 0;

  return {
    lessons: { pct: lessonsPct, applicable: totalLessons > 0 },
    assignments: { pct: assignmentsPct, applicable: totalAssignments > 0 },
    tests: { pct: testsPct, applicable: totalExams > 0 },
    attendance: { pct: attendancePct, applicable: totalSessions > 0 },
    lessonsPctRaw: lessonsPct
  };
}

function weightedScore(components, weights) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const key of ['lessons', 'assignments', 'tests', 'attendance']) {
    if (components[key].applicable) {
      totalWeight += weights[key];
      weightedSum += weights[key] * components[key].pct;
    }
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

// Recomputes and saves one student's progress for one course, applies the completion rule, and
// fires the appropriate notification exactly once per real transition. Safe to call from
// anywhere, as often as needed — every read is fresh, nothing here trusts a cached value.
async function recalculateEnrollmentProgress(studentId, courseId) {
  const [course, enrollment] = await Promise.all([
    Course.findById(courseId),
    Enrollment.findOne({ student: studentId, course: courseId })
  ]);
  if (!course || !enrollment) return null;

  const components = await computeComponents(studentId, courseId);
  const weights = { ...DEFAULT_WEIGHTS, ...(course.completionRules?.weights || {}) };
  const overallScore = weightedScore(components, weights);

  const minAttendance = course.completionRules?.minAttendancePercent || 0;
  const attendanceGateOk = !components.attendance.applicable || components.attendance.pct >= minAttendance;

  let feeBlocked = false;
  if (course.institution) {
    feeBlocked = Boolean(await getBlockingInstitutionFee(studentId, course.institution));
  }

  const meetsAllRequirements = overallScore >= 100 && attendanceGateOk && !feeBlocked;
  const previousStatus = enrollment.completionStatus;

  enrollment.progressPercent = Math.round(components.lessonsPctRaw);
  enrollment.overallScore = overallScore;

  if (meetsAllRequirements && enrollment.completionStatus !== 'completed') {
    if (course.completionRules?.requireTeacherApproval) {
      enrollment.completionStatus = 'pending_approval';
    } else {
      enrollment.completionStatus = 'completed';
      enrollment.status = 'completed';
      enrollment.completedAt = new Date();
    }
  } else if (!meetsAllRequirements && enrollment.completionStatus !== 'in_progress') {
    // Requirements regressed after the fact (new lesson/assignment/test added, fee became due,
    // attendance dropped) — reopen rather than leave a stale "completed" that no longer holds.
    enrollment.completionStatus = 'in_progress';
    if (enrollment.status === 'completed') enrollment.status = 'active';
  }

  await enrollment.save();

  if (previousStatus !== enrollment.completionStatus) {
    await fireTransitionNotification(course, enrollment, previousStatus).catch(() => {});
  }

  return enrollment;
}

async function fireTransitionNotification(course, enrollment, previousStatus) {
  const student = await User.findById(enrollment.student).select('fullName email');
  if (!student) return;

  if (enrollment.completionStatus === 'pending_approval') {
    const teacher = await User.findById(course.teacher).select('email');
    if (teacher) {
      await notify(
        course.teacher,
        { title: `${student.fullName} is ready for completion approval — "${course.title}"`, body: `${student.fullName} has met every requirement for "${course.title}" and is waiting for your approval to mark the course complete.` },
        { email: true, toAddress: teacher.email }
      );
    }
  } else if (enrollment.completionStatus === 'completed' && previousStatus !== 'completed') {
    const teacher = await User.findById(course.teacher).select('email');
    if (teacher) {
      await notify(
        course.teacher,
        { title: `${student.fullName} completed "${course.title}"`, body: `${student.fullName} finished every requirement in ${course.title}.` },
        { email: true, toAddress: teacher.email }
      );
    }
    if (previousStatus === 'pending_approval') {
      await notify(
        enrollment.student,
        { title: `Course completed: "${course.title}"`, body: `Your teacher approved your completion of "${course.title}".` },
        { email: true, toAddress: student.email }
      );
    }
  }
}

// Recomputes every active enrollment in a course — used when something course-wide changes
// (a lesson/assignment/exam is added or published), since that can reopen students who were
// previously marked complete under the old, smaller set of requirements.
async function recalculateEnrollmentProgressForCourse(courseId) {
  const enrollments = await Enrollment.find({ course: courseId, status: { $ne: 'dropped' } }).select('student');
  await Promise.all(enrollments.map((e) => recalculateEnrollmentProgress(e.student, courseId).catch(() => {})));
}

module.exports = { recalculateEnrollmentProgress, recalculateEnrollmentProgressForCourse, DEFAULT_WEIGHTS };
