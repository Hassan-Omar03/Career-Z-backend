const ForumThread = require('../models/ForumThread');
const ForumReply = require('../models/ForumReply');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

// Who may read/post in a course forum, and who moderates it.
async function forumAccess(courseId, user) {
  const course = await Course.findById(courseId).select('teacher institution title');
  if (!course) throw new AppError('Course not found.', 404);
  const uid = user._id.toString();
  const isTeacher = course.teacher.toString() === uid;
  let isModerator = isTeacher;
  if (!isModerator && course.institution) {
    const institution = await Institution.findById(course.institution).select('owner staff');
    isModerator = Boolean(institution) && (institution.owner.toString() === uid
      || institution.staff.some((s) => s.user.toString() === uid && (s.permissions || []).includes('forum:moderate')));
  }
  const isStudent = !isModerator && Boolean(await Enrollment.exists({ student: user._id, course: course._id, status: { $ne: 'dropped' } }));
  if (!isModerator && !isStudent) throw new AppError('Only the course teacher and enrolled students can use this forum.', 403);
  return { course, isTeacher, isModerator };
}

const clean = (value, max) => String(value || '').trim().slice(0, max);

// GET /api/forum/courses/:courseId/threads?lesson=&q=
const listThreads = asyncHandler(async (req, res) => {
  const { isModerator } = await forumAccess(req.params.courseId, req.user);
  const filter = { course: req.params.courseId };
  if (req.query.lesson) filter.lesson = req.query.lesson;
  if (!isModerator) filter.$or = [{ hidden: false }, { author: req.user._id }];
  if (req.query.q) filter.title = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const threads = await ForumThread.find(filter).populate('author', 'fullName').populate('lesson', 'title').sort({ pinned: -1, lastActivityAt: -1 }).limit(200);
  return ok(res, threads);
});

// POST /api/forum/courses/:courseId/threads — { title, body, lesson? }
const createThread = asyncHandler(async (req, res) => {
  const { course, isTeacher } = await forumAccess(req.params.courseId, req.user);
  const title = clean(req.body.title, 200);
  if (title.length < 3) throw new AppError('Give your question a title (at least 3 characters).', 422);
  const thread = await ForumThread.create({ course: course._id, lesson: req.body.lesson || null, author: req.user._id, title, body: clean(req.body.body, 10000) });
  if (!isTeacher) await notify(course.teacher, { title: `New question in ${course.title}: ${title}`, body: clean(req.body.body, 200), sentBy: req.user._id }).catch(() => {});
  return created(res, thread, 'Question posted.');
});

async function loadThread(id, user) {
  const thread = await ForumThread.findById(id);
  if (!thread) throw new AppError('Discussion not found.', 404);
  const access = await forumAccess(thread.course, user);
  if (thread.hidden && !access.isModerator && thread.author.toString() !== user._id.toString()) throw new AppError('Discussion not found.', 404);
  return { thread, ...access };
}

// GET /api/forum/threads/:id — the thread and its replies.
const getThread = asyncHandler(async (req, res) => {
  const { thread, isModerator } = await loadThread(req.params.id, req.user);
  const replyFilter = { thread: thread._id };
  if (!isModerator) replyFilter.$or = [{ hidden: false }, { author: req.user._id }];
  const [full, replies] = await Promise.all([
    ForumThread.findById(thread._id).populate('author', 'fullName').populate('lesson', 'title'),
    ForumReply.find(replyFilter).populate('author', 'fullName').sort({ createdAt: 1 })
  ]);
  return ok(res, { thread: full, replies, canModerate: isModerator });
});

// POST /api/forum/threads/:id/replies — { body }
const createReply = asyncHandler(async (req, res) => {
  const { thread, course, isModerator } = await loadThread(req.params.id, req.user);
  if (thread.locked && !isModerator) throw new AppError('This discussion is locked.', 409);
  const body = clean(req.body.body, 10000);
  if (!body) throw new AppError('Write a reply first.', 422);
  const reply = await ForumReply.create({ thread: thread._id, author: req.user._id, body, byTeacher: isModerator });
  await ForumThread.updateOne({ _id: thread._id }, { $inc: { replyCount: 1 }, $set: { lastActivityAt: new Date() } });
  const recipients = new Set([thread.author.toString(), course.teacher.toString()]);
  recipients.delete(req.user._id.toString());
  await Promise.all([...recipients].map((userId) => notify(userId, { title: `New reply: ${thread.title}`, body: body.slice(0, 200), sentBy: req.user._id }).catch(() => {})));
  return created(res, reply, 'Reply posted.');
});

// PATCH /api/forum/threads/:id — author edits title/body; moderators pin/lock/hide.
const updateThread = asyncHandler(async (req, res) => {
  const { thread, isModerator } = await loadThread(req.params.id, req.user);
  const isAuthor = thread.author.toString() === req.user._id.toString();
  const moderation = ['pinned', 'locked', 'hidden'].filter((k) => k in req.body);
  if (moderation.length && !isModerator) throw new AppError('Only the teacher or a forum moderator can pin, lock or hide.', 403);
  if (('title' in req.body || 'body' in req.body) && !isAuthor) throw new AppError('Only the author can edit this question.', 403);
  if ('title' in req.body) { const title = clean(req.body.title, 200); if (title.length < 3) throw new AppError('Title is too short.', 422); thread.title = title; }
  if ('body' in req.body) thread.body = clean(req.body.body, 10000);
  for (const key of moderation) thread[key] = Boolean(req.body[key]);
  if ('hidden' in req.body) thread.hiddenReason = thread.hidden ? clean(req.body.hiddenReason, 300) : '';
  await thread.save();
  return ok(res, thread, 'Discussion updated.');
});

// PATCH /api/forum/replies/:id — author edits; moderators hide/unhide.
const updateReply = asyncHandler(async (req, res) => {
  const reply = await ForumReply.findById(req.params.id);
  if (!reply) throw new AppError('Reply not found.', 404);
  const { isModerator } = await loadThread(reply.thread, req.user);
  const isAuthor = reply.author.toString() === req.user._id.toString();
  if ('hidden' in req.body) {
    if (!isModerator) throw new AppError('Only the teacher or a forum moderator can hide replies.', 403);
    reply.hidden = Boolean(req.body.hidden);
    reply.hiddenReason = reply.hidden ? clean(req.body.hiddenReason, 300) : '';
  }
  if ('body' in req.body) {
    if (!isAuthor) throw new AppError('Only the author can edit this reply.', 403);
    const body = clean(req.body.body, 10000);
    if (!body) throw new AppError('Reply cannot be empty.', 422);
    reply.body = body; reply.editedAt = new Date();
  }
  await reply.save();
  return ok(res, reply, 'Reply updated.');
});

// POST /api/forum/threads/:id/accept — { replyId } (thread author or teacher; null clears).
const acceptReply = asyncHandler(async (req, res) => {
  const { thread, isModerator } = await loadThread(req.params.id, req.user);
  if (!isModerator && thread.author.toString() !== req.user._id.toString()) throw new AppError('Only the asker or the teacher can mark the answer.', 403);
  const replyId = req.body.replyId || null;
  if (replyId && !(await ForumReply.exists({ _id: replyId, thread: thread._id, hidden: false }))) throw new AppError('That reply is not part of this discussion.', 422);
  thread.acceptedReply = replyId;
  await thread.save();
  return ok(res, thread, replyId ? 'Marked as the answer.' : 'Answer cleared.');
});

// POST /api/forum/replies/:id/like — toggles the caller's like.
const toggleLike = asyncHandler(async (req, res) => {
  const reply = await ForumReply.findById(req.params.id);
  if (!reply || reply.hidden) throw new AppError('Reply not found.', 404);
  await loadThread(reply.thread, req.user);
  const liked = reply.likes.some((u) => u.toString() === req.user._id.toString());
  await ForumReply.updateOne({ _id: reply._id }, liked ? { $pull: { likes: req.user._id } } : { $addToSet: { likes: req.user._id } });
  return ok(res, { liked: !liked, likes: reply.likes.length + (liked ? -1 : 1) });
});

module.exports = { listThreads, createThread, getThread, createReply, updateThread, updateReply, acceptReply, toggleLike };
