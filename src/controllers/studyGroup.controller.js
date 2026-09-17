const StudyGroup = require('../models/StudyGroup');
const StudyGroupPost = require('../models/StudyGroupPost');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// Student Community (spec Part 10.20) — any student can create a Study Group and invite others;
// membership gates who can read/post in its discussion room.

// GET /api/study-groups — discover groups (optionally filtered to a subject).
const listGroups = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.subject) filter.subject = new RegExp(req.query.subject, 'i');
  const groups = await StudyGroup.find(filter).populate('createdBy', 'fullName').sort({ createdAt: -1 }).limit(100);
  return ok(res, groups.map((g) => ({ ...g.toObject(), memberCount: g.members.length })));
});

// GET /api/study-groups/mine — groups I created or joined.
const myGroups = asyncHandler(async (req, res) => {
  const groups = await StudyGroup.find({ members: req.user._id }).populate('createdBy', 'fullName').sort({ createdAt: -1 });
  return ok(res, groups.map((g) => ({ ...g.toObject(), memberCount: g.members.length })));
});

// POST /api/study-groups
const createGroup = asyncHandler(async (req, res) => {
  const { name, description, subject } = req.body;
  if (!name) throw new AppError('name is required.', 422);
  const group = await StudyGroup.create({
    name, description: description || '', subject: subject || '',
    createdBy: req.user._id, members: [req.user._id]
  });
  return created(res, group, 'Study group created.');
});

// GET /api/study-groups/:id
const getGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id).populate('createdBy', 'fullName').populate('members', 'fullName profilePhoto');
  if (!group) throw new AppError('Study group not found.', 404);
  return ok(res, group);
});

// POST /api/study-groups/:id/join
const joinGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  if (!group.members.some((m) => m.toString() === req.user._id.toString())) {
    group.members.push(req.user._id);
    await group.save();
  }
  return ok(res, group, 'Joined study group.');
});

// POST /api/study-groups/:id/leave
const leaveGroup = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  group.members = group.members.filter((m) => m.toString() !== req.user._id.toString());
  await group.save();
  return ok(res, group, 'Left study group.');
});

function assertMember(group, userId) {
  if (!group.members.some((m) => m.toString() === userId.toString())) {
    throw new AppError('Join this group to see its discussion.', 403);
  }
}

// GET /api/study-groups/:id/posts
const listPosts = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const posts = await StudyGroupPost.find({ group: group._id }).populate('author', 'fullName profilePhoto').sort({ createdAt: 1 });
  return ok(res, posts);
});

// POST /api/study-groups/:id/posts
const addPost = asyncHandler(async (req, res) => {
  const group = await StudyGroup.findById(req.params.id);
  if (!group) throw new AppError('Study group not found.', 404);
  assertMember(group, req.user._id);

  const { text } = req.body;
  if (!text || !text.trim()) throw new AppError('text is required.', 422);
  const post = await StudyGroupPost.create({ group: group._id, author: req.user._id, text: text.trim() });
  const populated = await post.populate('author', 'fullName profilePhoto');
  return created(res, populated, 'Posted.');
});

module.exports = { listGroups, myGroups, createGroup, getGroup, joinGroup, leaveGroup, listPosts, addPost };
