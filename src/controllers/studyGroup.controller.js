const StudyGroup = require('../models/StudyGroup');
const StudyGroupPost = require('../models/StudyGroupPost');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const { emitToUser, broadcastStudyGroupPost } = require('../realtime/socket');

// Student Community (spec Part 10.20) — Study Groups. Always tied to one course, so
// discovery/join/manage are all scoped to that course's own institution — a student from one
// institution can never see or join another institution's group (mirrors the access pattern in
// anonymousQuestion.controller.js / poll.controller.js).

async function assertTeachesCourse(courseId, userId) {
  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found.', 404);
  if (course.teacher.toString() !== userId.toString()) throw new AppError('You do not teach this course.', 403);
  return course;
}

async function assertEnrolled(courseId, userId) {
  const enrollment = await Enrollment.findOne({ student: userId, course: courseId, status: { $ne: 'dropped' } });
  if (!enrollment) throw new AppError('You are not enrolled in this course.', 403);
  return enrollment;
}

// Handles both a raw ObjectId ref and an already-populated user doc (getGroup populates
// members.user/owner before these are called) by unwrapping ._id when present.
function idOf(value) {
  return String(value?._id || value);
}

function isMember(group, userId) {
  return group.members.some((m) => idOf(m.user) === idOf(userId));
}

function isOwner(group, userId) {
  return idOf(group.owner) === idOf(userId);
}

async function isCourseTeacher(group, userId) {
  const course = await Course.findById(group.course);
  return Boolean(course && course.teacher.toString() === userId.toString());
}

function assertMember(group, userId) {
  if (!isMember(group, userId)) throw new AppError('Join this group to see its discussion.', 403);
}

function idEq(a, b) {
  return idOf(a) === idOf(b);
}

function withCounts(group) {
  const obj = group.toObject ? group.toObject() : group;
  obj.memberCount = obj.members.length;
  obj.pendingCount = (obj.pendingRequests || []).length;
  return obj;
}

// GET /api/study-groups?courseId= (student) — discover open groups for one of the student's own
// actively-enrolled courses only. Never returns groups from a course/institution the student
// isn't part of.
const listGroups = asyncHandler(async (req, res) => {
  const { courseId } = req.query;
  if (!courseId) throw new AppError('courseId is required.', 422);
  await assertEnrolled(courseId, req.user._id);

  const groups = await StudyGroup.find({ course: courseId, status: 'active' })
    .populate('owner', 'fullName profilePhoto')
    .sort({ createdAt: -1 })
    .limit(100);
  return ok(res, groups.map(withCounts));
});

// GET /api/study-groups/mine (student/teacher) — groups I belong to (member or owner).
const myGroups = asyncHandler(async (req, res) => {
  const groups = await StudyGroup.find({ 'members.user': req.user._id })
    .populate('owner', 'fullName profilePhoto')
    .populate('course', 'title')
    .sort({ createdAt: -1 });
  return ok(res, groups.map(withCounts));
});

// POST /api/study-groups (student only) — must be actively enrolled in the target course, and
// the course/institution must have Study Groups enabled.
const createGroup = asyncHandler(async (req, res) => {
  const { name, description, subject, courseId, joinPolicy, maxMembers } = req.body;
  if (!name || !courseId) throw new AppError('name and courseId are required.', 422);
  await assertEnrolled(courseId, req.user._id);

  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found.', 404);
  if (course.studyGroupsEnabled === false) throw new AppError('Study Groups are disabled for this class by the institution.', 403);
  if (!course.institution) throw new AppError('This course is not linked to an institution.', 422);

  const group = await StudyGroup.create({
    name,
    description: description || '',
    subject: subject || course.subject || '',
    institution: course.institution,
    course: course._id,
    createdBy: req.user._id,
    createdByRole: 'student',
    owner: req.user._id,
    members: [{ user: req.user._id }],
    joinPolicy: joinPolicy === 'approval' ? 'approval' : 'open',
    maxMembers: maxMembers && maxMembers >= 2 && maxMembers <= 50 ? maxMembers : 6
  });
  return created(res, withCounts(group), 'Study group created.');
});

// GET /api/study-groups/:id — visible to members, the course's teacher, and the group owner.
const getGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id)
    .populate('owner', 'fullName profilePhoto')
    .populate('members.user', 'fullName profilePhoto')
    .populate('pendingRequests.user', 'fullName profilePhoto')
    .populate('course', 'title subject')
    .populate('individualMarks.user', 'fullName');
  if (!group) throw new AppError('Study group not found.', 404);

  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isMember(group, req.user._id) && !teaches) throw new AppError('You are not part of this group.', 403);

  return ok(res, withCounts(group));
});

// POST /api/study-groups/:id/join (student, open-policy groups only)
const joinGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  if (group.joinPolicy === 'managed') throw new AppError('This group is teacher-managed — ask your teacher to add you.', 403);
  if (isMember(group, req.user._id)) return ok(res, withCounts(group));
  await assertEnrolled(group.course, req.user._id);
  if (group.members.length >= group.maxMembers) throw new AppError('This group is full.', 400);

  if (group.joinPolicy === 'approval') {
    if (!group.pendingRequests.some((p) => p.user.toString() === req.user._id.toString())) {
      group.pendingRequests.push({ user: req.user._id });
      await group.save();
      emitToUser(group.owner, 'study-group:join-requested', { groupId: group.id });
    }
    return ok(res, withCounts(group), 'Join request sent — waiting for the group owner to approve.');
  }

  group.members.push({ user: req.user._id });
  await group.save();
  return ok(res, withCounts(group), 'Joined study group.');
});

// PATCH /api/study-groups/:id/requests/:userId (owner or course teacher) — approve/reject a
// pending join request. body: { action: 'approve' | 'reject' }
const decideJoinRequest = asyncHandler(async (req, res) => {
  const { action } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can decide join requests.', 403);

  const idx = group.pendingRequests.findIndex((p) => p.user.toString() === req.params.userId);
  if (idx === -1) throw new AppError('No such join request.', 404);
  const [request] = group.pendingRequests.splice(idx, 1);

  if (action === 'approve') {
    if (group.members.length >= group.maxMembers) throw new AppError('This group is full.', 400);
    group.members.push({ user: request.user });
  }
  await group.save();
  notify(request.user, {
    title: action === 'approve' ? 'Your study group join request was approved' : 'Your study group join request was declined',
    body: group.name,
    sentBy: req.user._id
  }).catch(() => {});
  return ok(res, withCounts(group), action === 'approve' ? 'Request approved.' : 'Request declined.');
});

// POST /api/study-groups/:id/leave — the owner cannot simply leave; they must transfer ownership
// or delete the group first, so a group never goes ownerless mid-project.
const leaveGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  if (isOwner(group, req.user._id)) {
    throw new AppError('You own this group — transfer ownership to another member or delete the group instead of leaving.', 400);
  }
  group.members = group.members.filter((m) => m.user.toString() !== req.user._id.toString());
  group.contributions = group.contributions.filter((c) => c.user.toString() !== req.user._id.toString());
  await group.save();
  return ok(res, withCounts(group), 'Left study group.');
});

// PATCH /api/study-groups/:id/transfer-ownership (owner only) — body: { userId }
const transferOwnership = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  if (!isOwner(group, req.user._id)) throw new AppError('Only the current owner can transfer ownership.', 403);
  if (!isMember(group, userId)) throw new AppError('That user is not a member of this group.', 422);

  group.owner = userId;
  await group.save();
  return ok(res, withCounts(group), 'Ownership transferred.');
});

// DELETE /api/study-groups/:id (owner or course teacher)
const deleteGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can delete this group.', 403);

  await StudyGroupPost.deleteMany({ group: group._id });
  await group.deleteOne();
  return ok(res, null, 'Study group deleted.');
});

// PATCH /api/study-groups/:id/members/:userId/remove (owner or course teacher) — moderation.
const removeMember = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can remove members.', 403);
  if (req.params.userId === group.owner.toString()) throw new AppError('The owner cannot be removed — transfer ownership first.', 400);

  group.members = group.members.filter((m) => m.user.toString() !== req.params.userId);
  group.contributions = group.contributions.filter((c) => c.user.toString() !== req.params.userId);
  await group.save();
  return ok(res, withCounts(group), 'Member removed.');
});

// ---- Teacher management screen ----

// GET /api/study-groups/teacher/courses/:courseId (teacher only) — every group in a class they
// teach, for oversight/monitoring/moderation.
const teacherCourseGroups = asyncHandler(async (req, res) => {
  await assertTeachesCourse(req.params.courseId, req.user._id);
  const groups = await StudyGroup.find({ course: req.params.courseId })
    .populate('owner', 'fullName profilePhoto')
    .populate('members.user', 'fullName profilePhoto')
    .sort({ createdAt: -1 });
  return ok(res, groups.map(withCounts));
});

// GET /api/study-groups/teacher/courses/:courseId/roster (teacher only) — enrolled students, for
// manual member selection when the teacher builds a group by hand.
const teacherCourseRoster = asyncHandler(async (req, res) => {
  await assertTeachesCourse(req.params.courseId, req.user._id);
  const enrollments = await Enrollment.find({ course: req.params.courseId, status: { $ne: 'dropped' } }).populate('student', 'fullName profilePhoto');
  return ok(res, enrollments.map((e) => ({ user: e.student, overallScore: e.overallScore })));
});

// POST /api/study-groups/teacher (teacher only) — manually pick members for a course they teach;
// membership is 'managed' — students can't self-leave/self-join.
const teacherCreateGroup = asyncHandler(async (req, res) => {
  const { name, description, courseId, memberIds } = req.body;
  if (!name || !courseId) throw new AppError('name and courseId are required.', 422);
  const course = await assertTeachesCourse(courseId, req.user._id);
  if (!course.institution) throw new AppError('This course is not linked to an institution.', 422);

  const ids = Array.isArray(memberIds) ? memberIds : [];
  const validEnrollments = await Enrollment.find({ course: courseId, student: { $in: ids }, status: { $ne: 'dropped' } });
  const validIds = new Set(validEnrollments.map((e) => e.student.toString()));
  const members = ids.filter((id) => validIds.has(id)).map((id) => ({ user: id }));

  const group = await StudyGroup.create({
    name,
    description: description || '',
    subject: course.subject || '',
    institution: course.institution,
    course: course._id,
    createdBy: req.user._id,
    createdByRole: 'teacher',
    owner: req.user._id,
    members: [{ user: req.user._id }, ...members],
    joinPolicy: 'managed',
    maxMembers: Math.max(members.length + 1, 6)
  });
  return created(res, withCounts(group), 'Study group created.');
});

// PATCH /api/study-groups/:id/members/add (owner or course teacher) — manual add, no approval
// flow needed since the person adding is already an authority over the group.
const addMember = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can add members.', 403);
  await assertEnrolled(group.course, userId);
  if (group.members.length >= group.maxMembers) throw new AppError('This group is full.', 400);
  if (!isMember(group, userId)) group.members.push({ user: userId });
  await group.save();
  return ok(res, withCounts(group), 'Member added.');
});

// PATCH /api/study-groups/:id/toggle-enabled — course-level kill switch (teacher or institution).
const setStudyGroupsEnabled = asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  const course = await assertTeachesCourse(req.body.courseId || req.params.courseId, req.user._id);
  course.studyGroupsEnabled = Boolean(enabled);
  await course.save();
  return ok(res, { courseId: course.id, studyGroupsEnabled: course.studyGroupsEnabled }, 'Updated.');
});

// ---- Project / tasks / resources / submission / marks ----

// PATCH /api/study-groups/:id/project (owner or course teacher)
const setProject = asyncHandler(async (req, res) => {
  const { title, instructions, deadline } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can set the project.', 403);

  group.project = { title: title || '', instructions: instructions || '', deadline: deadline || null };
  await group.save();
  return ok(res, withCounts(group), 'Project set.');
});

// POST /api/study-groups/:id/tasks (owner or course teacher)
const addTask = asyncHandler(async (req, res) => {
  const { title, assignedTo, dueDate } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!isOwner(group, req.user._id) && !teaches) throw new AppError('Only the group owner or the course teacher can assign tasks.', 403);
  if (assignedTo && !isMember(group, assignedTo)) throw new AppError('assignedTo must be a member of this group.', 422);

  group.tasks.push({ title, assignedTo: assignedTo || null, dueDate: dueDate || null });
  await group.save();
  return created(res, withCounts(group), 'Task added.');
});

// PATCH /api/study-groups/:id/tasks/:taskId (any member — updates status of their own task; owner/teacher can update any)
const updateTask = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'in_progress', 'done'].includes(status)) throw new AppError('Invalid status.', 422);
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const task = group.tasks.id(req.params.taskId);
  if (!task) throw new AppError('Task not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  const canEditAny = isOwner(group, req.user._id) || teaches;
  if (!canEditAny && task.assignedTo && task.assignedTo.toString() !== req.user._id.toString()) {
    throw new AppError('You can only update tasks assigned to you.', 403);
  }
  task.status = status;
  await group.save();
  return ok(res, withCounts(group), 'Task updated.');
});

// POST /api/study-groups/:id/resources (any member) — a Cloudinary URL from
// /api/media/platform/signature?folder=study-group-resources, uploaded by the browser directly.
const addResource = asyncHandler(async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) throw new AppError('name and url are required.', 422);
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  group.resources.push({ name, url, uploadedBy: req.user._id });
  await group.save();
  return created(res, withCounts(group), 'Resource shared.');
});

// PATCH /api/study-groups/:id/submission (any member) — group assignment submission, resubmittable.
const submitAssignment = asyncHandler(async (req, res) => {
  const { text, files } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  group.submission = {
    text: text || '',
    files: Array.isArray(files) ? files : [],
    submittedBy: req.user._id,
    submittedAt: new Date()
  };
  await group.save();
  return ok(res, withCounts(group), 'Assignment submitted.');
});

// PATCH /api/study-groups/:id/contribution (any member) — self-reported note on what they did;
// individual-contribution tracking for the teacher to weigh when grading.
const setContribution = asyncHandler(async (req, res) => {
  const { note } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const existing = group.contributions.find((c) => c.user.toString() === req.user._id.toString());
  if (existing) {
    existing.note = note || '';
    existing.updatedAt = new Date();
  } else {
    group.contributions.push({ user: req.user._id, note: note || '' });
  }
  await group.save();
  return ok(res, withCounts(group), 'Contribution note saved.');
});

// PATCH /api/study-groups/:id/marks (course teacher only) — body: { groupMarks, individualMarks: [{userId, marks}] }
const setMarks = asyncHandler(async (req, res) => {
  const { groupMarks, individualMarks } = req.body;
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  const teaches = await isCourseTeacher(group, req.user._id);
  if (!teaches) throw new AppError('Only the course teacher can grade this group.', 403);

  if (groupMarks !== undefined) {
    if (groupMarks < 0 || groupMarks > 100) throw new AppError('groupMarks must be 0-100.', 422);
    group.groupMarks = groupMarks;
  }
  if (Array.isArray(individualMarks)) {
    for (const entry of individualMarks) {
      if (!isMember(group, entry.userId) || entry.marks < 0 || entry.marks > 100) continue;
      const existing = group.individualMarks.find((m) => m.user.toString() === entry.userId);
      if (existing) {
        existing.marks = entry.marks;
        existing.gradedBy = req.user._id;
        existing.gradedAt = new Date();
      } else {
        group.individualMarks.push({ user: entry.userId, marks: entry.marks, gradedBy: req.user._id });
      }
    }
  }
  await group.save();
  return ok(res, withCounts(group), 'Marks recorded.');
});

// ---- AI Group Maker (rule-based balanced grouping) ----

// POST /api/study-groups/teacher/ai-generate (teacher only) — body: { courseId, groupSize }
// Balances groups by each enrolled student's overallScore (performance tier), so no group is
// stacked with only top or only struggling students — a deterministic, explainable stand-in for
// "AI" grouping rather than an opaque LLM call.
const aiGenerateGroups = asyncHandler(async (req, res) => {
  const { courseId, groupSize } = req.body;
  const size = Number(groupSize) >= 2 ? Number(groupSize) : 4;
  const course = await assertTeachesCourse(courseId, req.user._id);
  if (!course.institution) throw new AppError('This course is not linked to an institution.', 422);

  const enrollments = await Enrollment.find({ course: courseId, status: { $ne: 'dropped' } }).populate('student', 'fullName');
  if (enrollments.length < 2) throw new AppError('Not enough enrolled students to form groups.', 400);

  // Sort by performance descending, then snake-draft into buckets so each group gets a mix of
  // high/mid/low performers instead of clustering similarly-scored students together.
  const sorted = [...enrollments].sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
  const groupCount = Math.max(1, Math.round(sorted.length / size));
  const buckets = Array.from({ length: groupCount }, () => []);
  let dir = 1;
  let idx = 0;
  for (const e of sorted) {
    buckets[idx].push(e.student);
    idx += dir;
    if (idx === groupCount) { idx = groupCount - 1; dir = -1; }
    else if (idx < 0) { idx = 0; dir = 1; }
  }

  const existingCount = await StudyGroup.countDocuments({ course: courseId, aiGenerated: true });
  const groups = await StudyGroup.insertMany(
    buckets.filter((b) => b.length > 0).map((members, i) => ({
      name: `${course.title} — AI Group ${existingCount + i + 1}`,
      subject: course.subject || '',
      institution: course.institution,
      course: course._id,
      createdBy: req.user._id,
      createdByRole: 'teacher',
      aiGenerated: true,
      owner: req.user._id,
      members: [{ user: req.user._id }, ...members.map((m) => ({ user: m._id }))],
      joinPolicy: 'managed',
      maxMembers: Math.max(members.length + 1, size + 1)
    }))
  );
  return created(res, groups.map(withCounts), `${groups.length} balanced groups created.`);
});

// ---- Discussion ----

// GET /api/study-groups/:id/posts
const listPosts = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const posts = await StudyGroupPost.find({ group: group._id }).populate('author', 'fullName profilePhoto').sort({ createdAt: 1 });
  return ok(res, posts);
});

// POST /api/study-groups/:id/posts — also broadcast over the study-group:${id} socket room so
// other online members see it instantly instead of only after a reload/poll.
const addPost = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const { text, attachments } = req.body;
  if ((!text || !text.trim()) && !(Array.isArray(attachments) && attachments.length)) {
    throw new AppError('text or an attachment is required.', 422);
  }
  const post = await StudyGroupPost.create({
    group: group._id,
    author: req.user._id,
    text: text ? text.trim() : '',
    attachments: Array.isArray(attachments) ? attachments : []
  });
  const populated = await post.populate('author', 'fullName profilePhoto');
  broadcastStudyGroupPost(group.id, populated);

  return created(res, populated, 'Posted.');
});

module.exports = {
  listGroups, myGroups, createGroup, getGroup, joinGroup, decideJoinRequest, leaveGroup,
  transferOwnership, deleteGroup, removeMember, addMember,
  teacherCourseGroups, teacherCourseRoster, teacherCreateGroup, setStudyGroupsEnabled,
  setProject, addTask, updateTask, addResource, submitAssignment, setContribution, setMarks,
  aiGenerateGroups, listPosts, addPost
};
