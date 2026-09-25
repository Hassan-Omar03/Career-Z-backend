const Course = require('../models/Course');
const Lesson = require('../models/Lesson');
const Enrollment = require('../models/Enrollment');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Result = require('../models/Result');
const Exam = require('../models/Exam');
const ExamSubmission = require('../models/ExamSubmission');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const { assertInstitutionFeeAccess, getBlockingInstitutionFee } = require('../utils/feeAccess');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyParentsOfStudent } = require('../services/notification.service');
const { recalculateEnrollmentProgress, recalculateEnrollmentProgressForCourse } = require('../utils/courseProgress');

function assertTeacherOwnsCourse(course, userId) {
  if (course.teacher.toString() !== userId.toString()) {
    throw new AppError('You do not own this course.', 403);
  }
}

function sanitizeSlideDeck(deck) {
  if (!deck || !Array.isArray(deck.slides) || deck.slides.length < 1 || deck.slides.length > 50) {
    throw new AppError('A slide deck must contain between 1 and 50 slides.', 422);
  }
  return {
    version: 1,
    slides: deck.slides.map((slide) => {
      const imageUrl = String(slide.imageUrl || '');
      if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
        throw new AppError('Slide images must be uploaded to permanent HTTPS storage before sharing.', 422);
      }
      return {
        title: String(slide.title || '').trim().slice(0, 300),
        bullets: (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, 20).map((b) => String(b).trim().slice(0, 2000)),
        background: /^#[0-9a-f]{6}$/i.test(slide.background) ? slide.background : '#fff8e7',
        accent: /^#[0-9a-f]{6}$/i.test(slide.accent) ? slide.accent : '#d97706',
        text: /^#[0-9a-f]{6}$/i.test(slide.text) ? slide.text : '#1f2937',
        imageUrl
      };
    })
  };
}

function gradeFromPercent(percent) {
  if (percent >= 90) return 'A+';
  if (percent >= 80) return 'A';
  if (percent >= 70) return 'B';
  if (percent >= 60) return 'C';
  if (percent >= 50) return 'D';
  return 'F';
}

// ---- Courses ----

// POST /api/courses
const createCourse = asyncHandler(async (req, res) => {
  if (!(await isRoleVerified(req.user._id, 'teacher'))) {
    throw new AppError('Your Teacher account is pending Super Admin verification. You can browse the dashboard but cannot create a course until it is approved.', 403);
  }

  const { title, description, institution, classSection, subject, level, language, price, currency, isFree } = req.body;
  if (!title) throw new AppError('Title is required.', 422);

  const course = await Course.create({
    title,
    description,
    teacher: req.user._id,
    institution: institution || null,
    classSection: classSection || null,
    subject,
    level,
    language,
    price: price || 0,
    currency: currency || 'USD',
    // Institution subjects are assigned through the degree plan; they are never a public
    // zero-price self-enrolment product. Independent teachers may still publish free courses.
    isFree: institution ? false : (isFree !== undefined ? isFree : true)
  });

  if (institution) {
    await TeacherProfile.findOneAndUpdate(
      { user: req.user._id },
      { $addToSet: { institutions: institution } },
      { upsert: true }
    );
  }

  return created(res, course);
});

// GET /api/courses (public, published only)
const listCourses = asyncHandler(async (req, res) => {
  const { subject, institution, q } = req.query;
  const filter = { published: true, testOnly: { $ne: true } };
  if (subject) filter.subject = subject;
  if (institution) filter.institution = institution;
  if (q) filter.title = { $regex: q, $options: 'i' };

  const courses = await Course.find(filter)
    .populate('teacher', 'fullName email')
    .populate('institution', 'name')
    .populate('classSection', 'name academicYear')
    .sort({ createdAt: -1 });
  return ok(res, courses);
});

// GET /api/courses/mine (teacher's own courses, including unpublished)
const myCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({ teacher: req.user._id })
    .populate('teacher', 'fullName email')
    .populate('institution', 'name')
    .populate('classSection', 'name academicYear')
    .sort({ createdAt: -1 });
  return ok(res, courses);
});

// GET /api/courses/:id
const getCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).populate('teacher', 'fullName').populate('institution', 'name');
  if (!course) throw new AppError('Course not found.', 404);

  // Lesson content/resources are only for the owning teacher or an enrolled student —
  // an unpublished (or someone else's) course should not leak its material to a browser.
  const isOwner = req.user && course.teacher._id.toString() === req.user._id.toString();
  let canSeeLessons = Boolean(isOwner);
  if (!canSeeLessons && req.user) {
    const enrollment = await Enrollment.findOne({ student: req.user._id, course: course._id });
    canSeeLessons = Boolean(enrollment);
    if (canSeeLessons && course.institution) await assertInstitutionFeeAccess(req.user._id, course.institution._id || course.institution);
  }

  const lessonFilter = { course: course._id };
  if (!isOwner) lessonFilter.published = { $ne: false };
  const lessons = canSeeLessons ? await Lesson.find(lessonFilter).sort({ order: 1 }) : [];
  return ok(res, { course, lessons });
});

// PATCH /api/courses/:id
const updateCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const allowed = ['title', 'description', 'subject', 'level', 'language', 'price', 'currency', 'isFree', 'thumbnail', 'published', 'certificateEnabled'];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) course[f] = req.body[f];
  });

  let rulesChanged = false;
  if (req.body.completionRules) {
    const { weights, minAttendancePercent, requireTeacherApproval } = req.body.completionRules;
    if (weights) {
      const sum = ['lessons', 'assignments', 'tests', 'attendance'].reduce((s, k) => s + (Number(weights[k]) || 0), 0);
      if (Math.abs(sum - 100) > 1) throw new AppError('Completion weights must add up to 100.', 422);
      course.completionRules.weights = weights;
    }
    if (minAttendancePercent !== undefined) course.completionRules.minAttendancePercent = minAttendancePercent;
    if (requireTeacherApproval !== undefined) course.completionRules.requireTeacherApproval = requireTeacherApproval;
    rulesChanged = true;
  }

  await course.save();
  // Changing the rules can move students in either direction (stricter rules reopen someone who
  // was done under the old ones; looser rules complete someone who was blocked under the old ones).
  if (rulesChanged) await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});
  return ok(res, course);
});

// ---- Lessons ----

// POST /api/courses/:id/lessons
const addLesson = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { title, content, videoUrl, resources, order } = req.body;
  if (!title) throw new AppError('Lesson title is required.', 422);

  const lesson = await Lesson.create({ course: course._id, title, content, videoUrl, resources, order: order || 0 });
  // A new lesson changes the lesson-progress denominator for every enrolled student — anyone
  // previously at 100%/completed needs to be re-evaluated against the new total.
  await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});
  return created(res, lesson);
});

// POST /api/courses/:id/ai-resource — teacher shares AI-generated notes/quiz/lesson-plan text
// with this course. Saved as a real Lesson (so it shows up in the student's course view and the
// teacher's Resource Library the same as any manually-added lesson), then every actively
// enrolled student is notified in-app and by email that a new lecture was shared.
const shareAiResource = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { title, content, deck } = req.body;
  if (!title || (!content && !deck)) throw new AppError('Title and content or a slide deck are required.', 422);

  const cleanDeck = deck ? sanitizeSlideDeck(deck) : undefined;

  const lastLesson = await Lesson.findOne({ course: course._id }).sort({ order: -1 });
  const lesson = await Lesson.create({
    course: course._id,
    title: String(title).trim().slice(0, 300),
    content: content || '',
    kind: cleanDeck ? 'slide_deck' : 'lesson',
    deck: cleanDeck,
    published: true,
    order: (lastLesson?.order || 0) + 1
  });
  await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});

  // Same rule the student's own course/lesson view already enforces (getCourse, above): a
  // student with an unpaid blocking fee at this institution does not get told about new material
  // they cannot open yet. Deliberately status != 'dropped' rather than status === 'active' — a
  // student who already finished the course (status 'completed', via the weighted completion
  // engine) is still a real member and should still hear about new material, not be silently
  // excluded the moment they cross 100%. This was the actual cause of "0 students notified" on a
  // course with a real, active-looking enrollment: their status had flipped to 'completed'.
  const enrollments = await Enrollment.find({ course: course._id, status: { $ne: 'dropped' } }).populate('student', 'email fullName');
  const notifiable = [];
  for (const e of enrollments) {
    if (!e.student) continue;
    if (course.institution) {
      const blockingFee = await getBlockingInstitutionFee(e.student._id, course.institution);
      if (blockingFee) continue;
    }
    notifiable.push(e);
  }

  await Promise.all(notifiable.map((e) => notify(
    e.student._id,
    { title: `New lecture shared: ${title}`, body: `${req.user.fullName} shared "${title}" in ${course.title}.`, sentBy: req.user._id },
    { email: true, toAddress: e.student.email, ctaUrl: `/courses/${course._id}`, ctaLabel: 'View lecture' }
  )));

  return created(res, { lesson, notifiedCount: notifiable.length, feeBlockedCount: enrollments.length - notifiable.length });
});

// PATCH /api/lessons/:lessonId
const updateLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);

  const course = await Course.findById(lesson.course);
  assertTeacherOwnsCourse(course, req.user._id);

  const allowed = ['title', 'content', 'videoUrl', 'resources', 'order', 'published'];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) lesson[f] = req.body[f];
  });
  if (req.body.deck !== undefined) {
    lesson.deck = sanitizeSlideDeck(req.body.deck);
    lesson.kind = 'slide_deck';
  }
  await lesson.save();
  await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});
  return ok(res, lesson);
});

// DELETE /api/courses/lessons/:lessonId — owning teacher removes a lesson/deck from the class.
const deleteLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);
  const course = await Course.findById(lesson.course);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);
  await lesson.deleteOne();
  await Enrollment.updateMany({ course: course._id }, { $pull: { completedLessons: lesson._id } });
  await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});
  return ok(res, null, 'Lesson deleted.');
});

// PATCH /api/courses/lessons/:lessonId/complete — student marks a lesson watched/done. Updates
// lesson progress, then hands off to utils/courseProgress.js to recompute the real weighted
// course-completion score (lessons are only one of up to four inputs — see that file for why).
const completeLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);
  if (lesson.published === false) throw new AppError('This lesson is not published.', 404);

  const enrollment = await Enrollment.findOne({ student: req.user._id, course: lesson.course });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  const course = await Course.findById(lesson.course);
  await assertInstitutionFeeAccess(req.user._id, course?.institution);

  enrollment.completedLessons.addToSet(lesson._id);
  await enrollment.save();

  const updated = await recalculateEnrollmentProgress(req.user._id, lesson.course);
  return ok(res, updated || enrollment, 'Lesson marked complete.');
});

// ---- Enrollment ----

// POST /api/courses/:id/enroll
const enroll = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  if (!course.published) throw new AppError('This course is not published yet.', 400);

  const existing = await Enrollment.findOne({ student: req.user._id, course: course._id });
  if (existing) throw new AppError('You are already enrolled in this course.', 409);

  if (course.institution) {
    throw new AppError('Institution courses are assigned through admission/program enrollment. Self-enrollment is not available.', 403);
  }
  // Independent public courses may be free; paid ones require verified checkout.
  if (!course.isFree) {
    throw new AppError('This is a paid course. Complete checkout via the payments module first.', 402);
  }

  const enrollment = await Enrollment.create({ student: req.user._id, course: course._id });
  return created(res, enrollment, 'Enrolled successfully.');
});

// GET /api/courses/:id/students (teacher view)
const listEnrolledStudents = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const enrollments = await Enrollment.find({ course: course._id }).populate('student', 'fullName email');
  return ok(res, enrollments);
});

// PATCH /api/courses/:id/students/:studentId/approve-completion — only meaningful when the
// course's completionRules.requireTeacherApproval is on; the student must already have met every
// automated requirement (completionStatus === 'pending_approval') — this never lets a teacher
// approve someone who hasn't actually finished the work, only confirm someone who has.
const approveCompletion = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const enrollment = await Enrollment.findOne({ student: req.params.studentId, course: course._id });
  if (!enrollment) throw new AppError('Student is not enrolled in this course.', 404);
  if (enrollment.completionStatus !== 'pending_approval') {
    throw new AppError('This student is not waiting for completion approval.', 400);
  }

  enrollment.completionStatus = 'completed';
  enrollment.status = 'completed';
  enrollment.completedAt = new Date();
  await enrollment.save();

  if (course.certificateEnabled && course.institution) {
    const { ensureCourseCompletionCertificate } = require('../services/certificate.service');
    await ensureCourseCompletionCertificate(enrollment.student, course._id, req.user._id).catch(() => {});
  }

  const student = await User.findById(enrollment.student).select('fullName email');
  if (student) {
    await notify(
      enrollment.student,
      { title: `Course completed: "${course.title}"`, body: `Your teacher approved your completion of "${course.title}".`, sentBy: req.user._id },
      { email: true, toAddress: student.email }
    ).catch(() => {});
  }

  return ok(res, enrollment, 'Completion approved.');
});

// GET /api/courses/:id/face-descriptors (teacher view) — spec 15B.9 "Face Recognition"
// attendance. Returns each enrolled student's pre-computed 128-number face descriptor (from
// student.controller.js's saveMyFaceDescriptor) so the teacher's own browser can run live
// matching against the classroom camera — no face computation ever happens on this server.
const listFaceDescriptors = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const enrollments = await Enrollment.find({ course: course._id }).populate('student', 'fullName profilePhoto');
  const studentIds = enrollments.map((e) => e.student._id);
  const profiles = await StudentProfile.find({ user: { $in: studentIds }, faceDescriptor: { $ne: null } }).select('user faceDescriptor');

  const byUser = {};
  profiles.forEach((p) => { byUser[p.user.toString()] = p.faceDescriptor; });

  const enrolled = enrollments
    .filter((e) => byUser[e.student._id.toString()])
    .map((e) => ({ studentId: e.student._id, fullName: e.student.fullName, profilePhoto: e.student.profilePhoto || '', descriptor: byUser[e.student._id.toString()] }));

  return ok(res, enrolled);
});

// ---- Assignments ----

// POST /api/courses/:id/assignments
const createAssignment = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { title, type, description, dueDate, maxMarks, submissionMode, attachments, allowLate, rubric, published } = req.body;
  if (!title) throw new AppError('Assignment title is required.', 422);
  if (!Number.isFinite(Number(maxMarks || 100)) || Number(maxMarks || 100) <= 0) throw new AppError('maxMarks must be greater than zero.', 422);
  if (Array.isArray(rubric) && rubric.length > 0) {
    const rubricTotal = rubric.reduce((sum, row) => sum + (Number(row.maxMarks) || 0), 0);
    if (rubric.some((row) => !String(row.criterion || '').trim() || Number(row.maxMarks) <= 0) || rubricTotal !== Number(maxMarks || 100)) throw new AppError('Rubric criteria must be named and their marks must add up to maxMarks.', 422);
  }

  const assignment = await Assignment.create({
    course: course._id,
    teacher: req.user._id,
    title,
    type: type || 'assignment',
    description,
    dueDate,
    maxMarks: Number(maxMarks) || 100,
    submissionMode: submissionMode || 'either',
    allowLate: Boolean(allowLate),
    published: published !== false,
    rubric: Array.isArray(rubric) ? rubric : [],
    attachments: attachments || []
  });
  // New assignment changes the assignments-component denominator for every enrolled student.
  await recalculateEnrollmentProgressForCourse(course._id).catch(() => {});
  if (assignment.published) {
    const enrollments = await Enrollment.find({ course: course._id, status: 'active' }).populate('student', 'email');
    await Promise.all(enrollments.map(async (entry) => {
      if (course.institution && await getBlockingInstitutionFee(entry.student._id, course.institution)) return;
      await notify(entry.student._id, { title: `New ${assignment.type}: ${assignment.title}`, body: assignment.dueDate ? `Due ${new Date(assignment.dueDate).toLocaleString()}` : 'No deadline set.', sentBy: req.user._id }, { email: true, toAddress: entry.student.email }).catch(() => {});
    }));
  }
  return created(res, assignment);
});

// GET /api/courses/:id/assignments
const listAssignments = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  const isOwner = course.teacher.toString() === req.user._id.toString();
  if (!isOwner && !await Enrollment.exists({ student: req.user._id, course: course._id, status: { $ne: 'dropped' } })) {
    throw new AppError('You are not enrolled in this course.', 403);
  }
  if (!isOwner) await assertInstitutionFeeAccess(req.user._id, course.institution);
  const filter = { course: req.params.id };
  if (!isOwner) filter.published = { $ne: false };
  const assignments = await Assignment.find(filter).sort({ dueDate: 1 });
  if (!isOwner) return ok(res, assignments);
  const counts = await Submission.aggregate([
    { $match: { assignment: { $in: assignments.map((assignment) => assignment._id) } } },
    { $group: { _id: '$assignment', count: { $sum: 1 }, gradedCount: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } } } }
  ]);
  const countByAssignment = new Map(counts.map((row) => [row._id.toString(), row]));
  return ok(res, assignments.map((assignment) => {
    const submissionSummary = countByAssignment.get(assignment._id.toString());
    return { ...assignment.toObject(), submissionCount: submissionSummary?.count || 0, gradedCount: submissionSummary?.gradedCount || 0 };
  }));
});

// POST /api/assignments/:assignmentId/submit
const submitAssignment = asyncHandler(async (req, res) => {
  const assignment = await Assignment.findById(req.params.assignmentId);
  if (!assignment) throw new AppError('Assignment not found.', 404);

  const enrollment = await Enrollment.findOne({ student: req.user._id, course: assignment.course, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  if (assignment.published === false) throw new AppError('This assignment is not published.', 404);
  const course = await Course.findById(assignment.course);
  await assertInstitutionFeeAccess(req.user._id, course?.institution);
  const late = Boolean(assignment.dueDate && new Date() > assignment.dueDate);
  if (late && !assignment.allowLate) throw new AppError('The submission deadline has passed.', 409);

  const { text, attachments } = req.body;
  const hasText = Boolean(String(text || '').trim());
  const hasFile = Array.isArray(attachments) && attachments.length > 0;
  const mode = assignment.submissionMode || 'either';
  if (mode === 'text' && !hasText) throw new AppError('This assignment requires an online written answer.', 422);
  if (mode === 'file' && !hasFile) throw new AppError('This assignment requires a completed file or handwritten scan.', 422);
  if (mode === 'both' && (!hasText || !hasFile)) throw new AppError('This assignment requires both an online answer and a file.', 422);
  if (mode === 'either' && !hasText && !hasFile) throw new AppError('Write an answer or upload a completed file.', 422);

  const existing = await Submission.findOne({ assignment: assignment._id, student: req.user._id });
  if (existing) {
    existing.text = text || existing.text;
    existing.attachments = attachments || existing.attachments;
    existing.submittedAt = new Date();
    existing.status = 'submitted';
    existing.late = late;
    existing.marksObtained = null;
    existing.feedback = '';
    await existing.save();
    return ok(res, existing, 'Submission updated.');
  }

  const submission = await Submission.create({
    assignment: assignment._id,
    student: req.user._id,
    text,
    attachments: attachments || []
    ,late
  });

  await notify(assignment.teacher, {
    title: `${req.user.fullName} submitted "${assignment.title}"`,
    body: 'A new assignment submission is waiting for you to grade.',
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, submission, 'Assignment submitted.');
});

// GET /api/assignments/:assignmentId/submissions (teacher)
const listSubmissions = asyncHandler(async (req, res) => {
  const assignment = await Assignment.findById(req.params.assignmentId);
  if (!assignment) throw new AppError('Assignment not found.', 404);
  if (assignment.teacher.toString() !== req.user._id.toString()) {
    throw new AppError('You do not own this assignment.', 403);
  }

  const submissions = await Submission.find({ assignment: assignment._id }).populate('student', 'fullName email');
  return ok(res, submissions);
});

// DELETE /api/courses/assignments/:assignmentId
const deleteAssignment = asyncHandler(async (req, res) => {
  const assignment = await Assignment.findById(req.params.assignmentId);
  if (!assignment) throw new AppError('Assignment not found.', 404);
  if (assignment.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not own this assignment.', 403);
  await Submission.deleteMany({ assignment: assignment._id });
  await assignment.deleteOne();
  await recalculateEnrollmentProgressForCourse(assignment.course).catch(() => {});
  return ok(res, null, 'Assignment deleted.');
});

// PATCH /api/submissions/:submissionId/grade (teacher)
const gradeSubmission = asyncHandler(async (req, res) => {
  const { marksObtained, feedback } = req.body;
  const submission = await Submission.findById(req.params.submissionId).populate('assignment');
  if (!submission) throw new AppError('Submission not found.', 404);
  if (submission.assignment.teacher.toString() !== req.user._id.toString()) {
    throw new AppError('You do not own this assignment.', 403);
  }
  const usesMarks = !['homework', 'worksheet'].includes(submission.assignment.type);
  if (usesMarks && marksObtained === undefined) throw new AppError('marksObtained is required.', 422);
  const marks = usesMarks ? Number(marksObtained) : null;
  if (usesMarks && (!Number.isFinite(marks) || marks < 0 || marks > submission.assignment.maxMarks)) throw new AppError(`Marks must be between 0 and ${submission.assignment.maxMarks}.`, 422);

  submission.marksObtained = marks;
  submission.feedback = feedback || '';
  submission.gradedBy = req.user._id;
  submission.gradedAt = new Date();
  submission.status = 'graded';
  await submission.save();

  await notify(submission.student, { title: `${usesMarks ? 'Assignment graded' : 'Homework reviewed'}: ${submission.assignment.title}`, body: `${usesMarks ? `${marks}/${submission.assignment.maxMarks}` : 'Reviewed'}${submission.feedback ? ` · ${submission.feedback}` : ''}`, sentBy: req.user._id }).catch(() => {});

  await recalculateEnrollmentProgress(submission.student, submission.assignment.course).catch(() => {});
  return ok(res, submission, 'Submission graded.');
});

const requestAssignmentResubmission = asyncHandler(async (req, res) => {
  const submission = await Submission.findById(req.params.submissionId).populate('assignment');
  if (!submission) throw new AppError('Submission not found.', 404);
  if (submission.assignment.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not own this assignment.', 403);
  submission.status = 'resubmit_requested';
  submission.feedback = String(req.body.feedback || '').trim();
  submission.marksObtained = null;
  await submission.save();
  await notify(submission.student, { title: `Resubmission requested: ${submission.assignment.title}`, body: submission.feedback || 'Your teacher requested a revised submission.', sentBy: req.user._id }).catch(() => {});
  return ok(res, submission, 'Resubmission requested.');
});

// ---- Results ----

// POST /api/courses/:id/results (teacher records a result/exam score)
const recordResult = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { student, term, subject, marksObtained, totalMarks, grade } = req.body;
  if (!student || marksObtained === undefined || totalMarks === undefined) {
    throw new AppError('student, marksObtained and totalMarks are required.', 422);
  }

  const enrollment = await Enrollment.findOne({ student, course: course._id });
  if (!enrollment) throw new AppError('Student is not enrolled in this course.', 400);

  const result = await Result.create({
    student,
    course: course._id,
    institution: course.institution,
    term: term || '',
    subject: subject || course.subject,
    marksObtained,
    totalMarks,
    grade: grade || '',
    recordedBy: req.user._id
  });

  const studentUser = await User.findById(student).select('fullName');
  await notifyParentsOfStudent(student, {
    title: `New result posted for ${studentUser?.fullName || 'your child'}`,
    body: `${result.subject || course.subject}: ${marksObtained}/${totalMarks}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, result, 'Result recorded.');
});

// GET /api/courses/:id/results — one result register for online exams and offline entries.
const listCourseResults = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);
  const results = await Result.find({ course: course._id })
    .populate('student', 'fullName email')
    .populate('exam', 'title type passingPercent scheduledDate')
    .populate('classSection', 'name academicYear')
    .populate('teacher', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, results);
});

// ---- Exams ----

// POST /api/courses/:id/exams
const createExam = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { title, type, academicSession, term, durationMinutes, scheduledDate, closesAt, passingPercent, venue, instructions, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    throw new AppError('title and at least one question are required.', 422);
  }
  if (!Number.isFinite(Number(durationMinutes || 0)) || Number(durationMinutes || 0) < 0) throw new AppError('durationMinutes cannot be negative.', 422);
  if (scheduledDate && closesAt && new Date(closesAt) <= new Date(scheduledDate)) throw new AppError('closesAt must be after the scheduled opening time.', 422);
  if (questions.some((q) => !q.text || !Number.isFinite(Number(q.marks)) || Number(q.marks) <= 0)) throw new AppError('Every question needs text and marks greater than zero.', 422);
  if (questions.some((q) => q.type === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(q.correctOption) || q.correctOption < 0 || q.correctOption >= q.options.length))) throw new AppError('Every MCQ needs at least two options and one valid correct option.', 422);

  if (course.institution && !String(course.subject || '').trim()) throw new AppError('Set the course subject before creating an institutional exam.', 422);
  if (course.institution && !String(academicSession || course.classSection?.academicYear || '').trim()) throw new AppError('Academic session is required for an institutional exam.', 422);
  if (course.institution && !String(term || '').trim()) throw new AppError('Term/semester is required for an institutional exam.', 422);

  const exam = await Exam.create({
    course: course._id,
    teacher: req.user._id,
    institution: course.institution || null,
    classSection: course.classSection || null,
    subject: course.subject || course.title,
    academicSession: academicSession || '',
    term: term || '',
    title,
    type: type || 'quiz',
    durationMinutes: durationMinutes || 0,
    scheduledDate: scheduledDate || null,
    closesAt: closesAt || null,
    passingPercent: passingPercent === undefined ? 50 : Number(passingPercent),
    venue: venue || '',
    instructions: instructions || '',
    questions
  });
  return created(res, exam, 'Exam created (unpublished).');
});

// GET /api/courses/:id/exams
const listExams = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);

  const isOwner = course.teacher.toString() === req.user._id.toString();
  if (!isOwner) {
    if (!await Enrollment.exists({ student: req.user._id, course: course._id, status: { $ne: 'dropped' } })) throw new AppError('You are not enrolled in this course.', 403);
    await assertInstitutionFeeAccess(req.user._id, course.institution);
  }
  const filter = { course: course._id };
  if (!isOwner) filter.published = true;

  const exams = await Exam.find(filter)
    .populate('teacher', 'fullName email')
    .populate('institution', 'name')
    .populate('classSection', 'name academicYear')
    .sort({ createdAt: -1 });

  if (isOwner) return ok(res, exams);

  // Students never see the answer key.
  const sanitized = exams.map((e) => {
    const obj = e.toObject();
    obj.questions = obj.questions.map((q) => ({ text: q.text, type: q.type, options: q.options, marks: q.marks }));
    return obj;
  });
  return ok(res, sanitized);
});

// POST /api/courses/exams/:examId/start — server owns the attempt clock.
const startExam = asyncHandler(async (req, res) => {
  const exam = await Exam.findById(req.params.examId);
  if (!exam || !exam.published) throw new AppError('This exam is not open.', 404);
  const enrollment = await Enrollment.findOne({ student: req.user._id, course: exam.course, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not actively enrolled in this course.', 403);
  const course = await Course.findById(exam.course);
  await assertInstitutionFeeAccess(req.user._id, course?.institution);
  const now = new Date();
  if (exam.scheduledDate && now < exam.scheduledDate) throw new AppError(`This exam opens at ${exam.scheduledDate.toISOString()}.`, 409);
  if (exam.closesAt && now > exam.closesAt) throw new AppError('This exam has closed.', 409);
  let attempt = await ExamSubmission.findOne({ exam: exam._id, student: req.user._id });
  if (attempt && attempt.status !== 'in_progress') throw new AppError('You already submitted this exam.', 409);
  if (!attempt) {
    const expiresAt = exam.durationMinutes > 0 ? new Date(now.getTime() + exam.durationMinutes * 60000) : exam.closesAt;
    attempt = await ExamSubmission.create({ exam: exam._id, student: req.user._id, status: 'in_progress', startedAt: now, expiresAt: expiresAt || null, answers: [] });
  }
  if (attempt.expiresAt && now > attempt.expiresAt) throw new AppError('Your exam time has expired.', 409);
  const obj = exam.toObject();
  obj.questions = obj.questions.map((q) => ({ text: q.text, type: q.type, options: q.options, marks: q.marks }));
  return ok(res, { exam: obj, attempt: { _id: attempt._id, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt, status: attempt.status } });
});

const listMyExamAttempts = asyncHandler(async (req, res) => {
  const attempts = await ExamSubmission.find({ student: req.user._id }).select('exam score status startedAt expiresAt submittedAt');
  return ok(res, attempts);
});

// PATCH /api/exams/:examId/publish
const publishExam = asyncHandler(async (req, res) => {
  const exam = await Exam.findById(req.params.examId);
  if (!exam) throw new AppError('Exam not found.', 404);
  if (exam.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not own this exam.', 403);

  exam.published = true;
  await exam.save();
  // Publishing changes the tests-component denominator for every enrolled student.
  await recalculateEnrollmentProgressForCourse(exam.course).catch(() => {});
  const course = await Course.findById(exam.course);
  const enrolled = await Enrollment.find({ course: exam.course, status: 'active' }).populate('student', 'email');
  await Promise.all(enrolled.map(async (entry) => {
    if (course?.institution && await getBlockingInstitutionFee(entry.student._id, course.institution)) return;
    await notify(entry.student._id, { title: `Exam published: ${exam.title}`, body: exam.scheduledDate ? `Opens ${new Date(exam.scheduledDate).toLocaleString()}` : 'Available now.', sentBy: req.user._id }, { email: true, toAddress: entry.student.email }).catch(() => {});
  }));

  // "Upcoming examination" notification for parents — only meaningful once a date is set.
  if (exam.scheduledDate) {
    const enrolledStudents = await Enrollment.find({ course: exam.course }).select('student');
    await Promise.all(enrolledStudents.map((e) => notifyParentsOfStudent(e.student, {
      title: `Upcoming examination: ${exam.title}`,
      body: new Date(exam.scheduledDate).toLocaleString(),
      sentBy: req.user._id
    }).catch(() => {})));
  }

  return ok(res, exam, 'Exam published.');
});

// POST /api/exams/:examId/submit
const submitExam = asyncHandler(async (req, res) => {
  const exam = await Exam.findById(req.params.examId);
  if (!exam) throw new AppError('Exam not found.', 404);
  if (!exam.published) throw new AppError('This exam is not open yet.', 400);

  const enrollment = await Enrollment.findOne({ student: req.user._id, course: exam.course, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  const course = await Course.findById(exam.course);
  await assertInstitutionFeeAccess(req.user._id, course?.institution);

  const existing = await ExamSubmission.findOne({ exam: exam._id, student: req.user._id });
  if (!existing) throw new AppError('Start the exam before submitting it.', 409);
  if (existing.status !== 'in_progress') throw new AppError('You already submitted this exam.', 409);
  if (existing.expiresAt && Date.now() > existing.expiresAt.getTime() + 30000) throw new AppError('Your exam time has expired.', 409);

  const { answers } = req.body;
  if (!Array.isArray(answers)) throw new AppError('answers array is required.', 422);
  const indexes = answers.map((answer) => answer?.questionIndex);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= exam.questions.length)
      || new Set(indexes).size !== indexes.length) {
    throw new AppError('Each answer must refer to a distinct valid question.', 422);
  }
  if (answers.length !== exam.questions.length) throw new AppError('Submit one answer entry for every question.', 422);

  const gradedAnswers = answers.map((a) => {
    const question = exam.questions[a.questionIndex];
    if (!question) return { ...a, marksAwarded: 0 };
    if (question.type === 'mcq') {
      if (!Number.isInteger(a.selectedOption) || a.selectedOption < 0 || a.selectedOption >= question.options.length) return { questionIndex: a.questionIndex, selectedOption: null, textAnswer: '', marksAwarded: 0 };
      return { questionIndex: a.questionIndex, selectedOption: a.selectedOption, textAnswer: '', marksAwarded: 0 };
    }
    return { questionIndex: a.questionIndex, selectedOption: null, textAnswer: a.textAnswer || '', marksAwarded: 0 };
  });

  existing.answers = gradedAnswers;
  existing.score = 0;
  existing.status = 'submitted';
  existing.submittedAt = new Date();
  const submission = await existing.save();

  await notify(exam.teacher, {
    title: `${req.user.fullName} submitted "${exam.title}"`,
    body: 'All MCQ and written answers are ready for your review and grading.',
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, submission, 'Exam submitted. Your teacher will review every answer before publishing marks.');
});

// GET /api/exams/:examId/submissions (teacher)
const listExamSubmissions = asyncHandler(async (req, res) => {
  const exam = await Exam.findById(req.params.examId);
  if (!exam) throw new AppError('Exam not found.', 404);
  if (exam.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not own this exam.', 403);

  const submissions = await ExamSubmission.find({ exam: exam._id }).populate('student', 'fullName email');
  return ok(res, submissions);
});

// PATCH /api/exam-submissions/:submissionId/grade (teacher — grades the short-answer questions)
const gradeExamSubmission = asyncHandler(async (req, res) => {
  const submission = await ExamSubmission.findById(req.params.submissionId).populate('exam');
  if (!submission) throw new AppError('Exam submission not found.', 404);
  if (submission.exam.teacher.toString() !== req.user._id.toString()) throw new AppError('You do not own this exam.', 403);

  const { manualMarks, grade } = req.body; // [{ questionIndex, marks }], teacher-selected grade
  if (!Array.isArray(manualMarks)) throw new AppError('manualMarks array is required.', 422);
  if (manualMarks.length !== submission.exam.questions.length) throw new AppError('Enter marks for every question before completing the review.', 422);
  if (!String(grade || '').trim() || String(grade).trim().length > 20) throw new AppError('Select a valid final grade before publishing the result.', 422);

  const seen = new Set();
  manualMarks.forEach(({ questionIndex, marks }) => {
    if (!Number.isInteger(questionIndex) || seen.has(questionIndex)) throw new AppError('Each manually graded question must appear once.', 422);
    seen.add(questionIndex);
    const answer = submission.answers.find((a) => a.questionIndex === questionIndex);
    const question = submission.exam.questions[questionIndex];
    const numericMarks = Number(marks);
    if (!answer || !question || !Number.isFinite(numericMarks) || numericMarks < 0 || numericMarks > question.marks) throw new AppError(`Invalid marks for question ${questionIndex + 1}.`, 422);
    answer.marksAwarded = numericMarks;
  });

  submission.score = submission.answers.reduce((sum, a) => sum + (a.marksAwarded || 0), 0);
  submission.status = 'graded';
  submission.finalGrade = String(grade).trim();
  submission.gradedBy = req.user._id;
  submission.gradedAt = new Date();
  await submission.save();

  const course = await Course.findById(submission.exam.course);
  await Result.findOneAndUpdate({ student: submission.student, exam: submission.exam._id }, {
    student: submission.student,
    course: course._id,
    exam: submission.exam._id,
    institution: course.institution,
    classSection: submission.exam.classSection || course.classSection,
    teacher: submission.exam.teacher,
    academicSession: submission.exam.academicSession || '',
    term: submission.exam.term || submission.exam.type,
    subject: submission.exam.subject || course.subject || course.title,
    marksObtained: submission.score,
    totalMarks: submission.exam.toObject().totalMarks,
    grade: String(grade).trim(),
    recordedBy: req.user._id
  }, { upsert: true, new: true, runValidators: true });

  const gradedStudent = await User.findById(submission.student).select('fullName');
  await notifyParentsOfStudent(submission.student, {
    title: `New result posted for ${gradedStudent?.fullName || 'your child'}`,
    body: `${submission.exam.title}: ${submission.score}/${submission.exam.toObject().totalMarks}`,
    sentBy: req.user._id
  }).catch(() => {});

  await recalculateEnrollmentProgress(submission.student, submission.exam.course).catch(() => {});
  return ok(res, submission, 'Exam graded.');
});

module.exports = {
  createCourse, listCourses, myCourses, getCourse, updateCourse,
  addLesson, updateLesson, deleteLesson, completeLesson, shareAiResource,
  enroll, listEnrolledStudents, approveCompletion, listFaceDescriptors,
  createAssignment, listAssignments, deleteAssignment,
  submitAssignment, listSubmissions, gradeSubmission, requestAssignmentResubmission,
  recordResult, listCourseResults,
  createExam, listExams, publishExam, startExam, listMyExamAttempts, submitExam, listExamSubmissions, gradeExamSubmission
};
