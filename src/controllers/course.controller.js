const Course = require('../models/Course');
const Lesson = require('../models/Lesson');
const Enrollment = require('../models/Enrollment');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Result = require('../models/Result');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function assertTeacherOwnsCourse(course, userId) {
  if (course.teacher.toString() !== userId.toString()) {
    throw new AppError('You do not own this course.', 403);
  }
}

// ---- Courses ----

// POST /api/courses
const createCourse = asyncHandler(async (req, res) => {
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
    isFree: isFree !== undefined ? isFree : true
  });

  return created(res, course);
});

// GET /api/courses (public, published only)
const listCourses = asyncHandler(async (req, res) => {
  const { subject, institution, q } = req.query;
  const filter = { published: true };
  if (subject) filter.subject = subject;
  if (institution) filter.institution = institution;
  if (q) filter.title = { $regex: q, $options: 'i' };

  const courses = await Course.find(filter).populate('teacher', 'fullName').sort({ createdAt: -1 });
  return ok(res, courses);
});

// GET /api/courses/mine (teacher's own courses, including unpublished)
const myCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({ teacher: req.user._id }).sort({ createdAt: -1 });
  return ok(res, courses);
});

// GET /api/courses/:id
const getCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).populate('teacher', 'fullName');
  if (!course) throw new AppError('Course not found.', 404);
  const lessons = await Lesson.find({ course: course._id }).sort({ order: 1 });
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
  await course.save();
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
  return created(res, lesson);
});

// PATCH /api/lessons/:lessonId
const updateLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);

  const course = await Course.findById(lesson.course);
  assertTeacherOwnsCourse(course, req.user._id);

  const allowed = ['title', 'content', 'videoUrl', 'resources', 'order'];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) lesson[f] = req.body[f];
  });
  await lesson.save();
  return ok(res, lesson);
});

// ---- Enrollment ----

// POST /api/courses/:id/enroll
const enroll = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  if (!course.published) throw new AppError('This course is not published yet.', 400);

  const existing = await Enrollment.findOne({ student: req.user._id, course: course._id });
  if (existing) throw new AppError('You are already enrolled in this course.', 409);

  // Note: paid-course checkout is covered under Wallet/Payments scope; free courses enroll directly here.
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

// ---- Assignments ----

// POST /api/courses/:id/assignments
const createAssignment = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new AppError('Course not found.', 404);
  assertTeacherOwnsCourse(course, req.user._id);

  const { title, description, dueDate, maxMarks, attachments } = req.body;
  if (!title) throw new AppError('Assignment title is required.', 422);

  const assignment = await Assignment.create({
    course: course._id,
    teacher: req.user._id,
    title,
    description,
    dueDate,
    maxMarks: maxMarks || 100,
    attachments: attachments || []
  });
  return created(res, assignment);
});

// GET /api/courses/:id/assignments
const listAssignments = asyncHandler(async (req, res) => {
  const assignments = await Assignment.find({ course: req.params.id }).sort({ dueDate: 1 });
  return ok(res, assignments);
});

// POST /api/assignments/:assignmentId/submit
const submitAssignment = asyncHandler(async (req, res) => {
  const assignment = await Assignment.findById(req.params.assignmentId);
  if (!assignment) throw new AppError('Assignment not found.', 404);

  const enrollment = await Enrollment.findOne({ student: req.user._id, course: assignment.course });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);

  const { text, attachments } = req.body;
  if (!text && (!attachments || attachments.length === 0)) {
    throw new AppError('Provide submission text or at least one attachment.', 422);
  }

  const existing = await Submission.findOne({ assignment: assignment._id, student: req.user._id });
  if (existing) {
    existing.text = text || existing.text;
    existing.attachments = attachments || existing.attachments;
    existing.submittedAt = new Date();
    existing.status = 'submitted';
    await existing.save();
    return ok(res, existing, 'Submission updated.');
  }

  const submission = await Submission.create({
    assignment: assignment._id,
    student: req.user._id,
    text,
    attachments: attachments || []
  });
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

// PATCH /api/submissions/:submissionId/grade (teacher)
const gradeSubmission = asyncHandler(async (req, res) => {
  const { marksObtained, feedback } = req.body;
  if (marksObtained === undefined) throw new AppError('marksObtained is required.', 422);

  const submission = await Submission.findById(req.params.submissionId).populate('assignment');
  if (!submission) throw new AppError('Submission not found.', 404);
  if (submission.assignment.teacher.toString() !== req.user._id.toString()) {
    throw new AppError('You do not own this assignment.', 403);
  }

  submission.marksObtained = marksObtained;
  submission.feedback = feedback || '';
  submission.gradedBy = req.user._id;
  submission.gradedAt = new Date();
  submission.status = 'graded';
  await submission.save();

  return ok(res, submission, 'Submission graded.');
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

  return created(res, result, 'Result recorded.');
});

module.exports = {
  createCourse, listCourses, myCourses, getCourse, updateCourse,
  addLesson, updateLesson,
  enroll, listEnrolledStudents,
  createAssignment, listAssignments,
  submitAssignment, listSubmissions, gradeSubmission,
  recordResult
};
