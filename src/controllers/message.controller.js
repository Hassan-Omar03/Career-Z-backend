const Message = require('../models/Message');
const User = require('../models/User');
const BlockedUser = require('../models/BlockedUser');
const { notify } = require('../services/notification.service');
const { emitToUser, isUserOnline } = require('../realtime/socket');
const { canCommunicate, communicationContacts, operationalStaffScope } = require('../utils/messageAccess');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

const sendMessage = asyncHandler(async (req, res) => {
  const { to, text, attachments = [] } = req.body;
  await require('../services/chatSafety.service').validate(text);
  if (!to || (!text?.trim()&&!Array.isArray(attachments))) throw new AppError('to and text are required.', 422);
  if (to === req.user._id.toString()) throw new AppError('You cannot message yourself.', 422);
  const recipient = await User.findById(to);
  if (!recipient) throw new AppError('Recipient not found.', 404);
  if (!(await canCommunicate(req.user._id, to))) throw new AppError('You can only message an approved student, teacher, parent or institution contact.', 403);
  const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 5).map((item) => ({ name: String(item?.name || 'Attachment').slice(0, 150), url: String(item?.url || ''), type: String(item?.type || '').slice(0, 100) })).filter((item) => /^https:\/\//i.test(item.url)) : [];
  if(!text?.trim()&&!safeAttachments.length)throw new AppError('A message or valid attachment is required.',422);
  const message = await Message.create({ from: req.user._id, to, text: text?.trim()||'[Attachment]', attachments: safeAttachments, deliveredAt: isUserOnline(to) ? new Date() : null });
  const populated = await Message.findById(message._id).populate('from', 'fullName email roles profilePhoto').populate('to', 'fullName email roles profilePhoto');
  emitToUser(to, 'message:new', populated);
  emitToUser(req.user._id, 'message:new', populated);
  // Private chat uses message socket events and unread counts; no routine email/push alert.
  return created(res, populated, 'Message sent.');
});

const listContacts = asyncHandler(async (req, res) => ok(res, await communicationContacts(req.user._id)));

const listConversations = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const messages = await Message.find({ $or: [{ from: userId }, { to: userId }] }).sort({ createdAt: -1 }).populate('from', 'fullName email roles profilePhoto').populate('to', 'fullName email roles profilePhoto');
  const seen = new Map();
  for (const m of messages) {
    const other = m.from._id.toString() === userId.toString() ? m.to : m.from;
    const key = other._id.toString();
    if (!seen.has(key)) seen.set(key, { user: other, lastMessage: m.text, lastAt: m.createdAt, unread: 0 });
    if (m.to._id.toString() === userId.toString() && !m.read) seen.get(key).unread += 1;
  }
  const conversations = Array.from(seen.values());
  const staffScope = await operationalStaffScope(userId);
  return ok(res, staffScope
    ? conversations.filter((conversation) => staffScope.studentIds.has(String(conversation.user._id)))
    : conversations);
});

const getThread = asyncHandler(async (req, res) => {
  if (!(await canCommunicate(req.user._id, req.params.userId))) throw new AppError('This user is not an approved communication contact.', 403);
  const thread = await Message.find({ $or: [{ from: req.user._id, to: req.params.userId }, { from: req.params.userId, to: req.user._id }] }).sort({ createdAt: 1 });
  return ok(res, thread);
});

const markThreadRead = asyncHandler(async (req, res) => {
  if (!(await canCommunicate(req.user._id, req.params.userId))) throw new AppError('This user is not an approved communication contact.', 403);
  await Message.updateMany({ from: req.params.userId, to: req.user._id, read: false }, { $set: { read: true, readAt: new Date() } });
  emitToUser(req.params.userId, 'message:read', { by: req.user._id, at: new Date() });
  return ok(res, { marked: true });
});

// POST /api/messages/block/:userId — messaging preference: stop hearing from someone, without
// needing an institution/course to actually change (canCommunicate checks this first).
const blockUser = asyncHandler(async (req, res) => {
  if (req.params.userId === req.user._id.toString()) throw new AppError('You cannot block yourself.', 422);
  await BlockedUser.findOneAndUpdate(
    { blocker: req.user._id, blocked: req.params.userId },
    { blocker: req.user._id, blocked: req.params.userId },
    { upsert: true, setDefaultsOnInsert: true }
  );
  return ok(res, { blocked: true }, 'User blocked.');
});

const unblockUser = asyncHandler(async (req, res) => {
  await BlockedUser.deleteOne({ blocker: req.user._id, blocked: req.params.userId });
  return ok(res, { blocked: false }, 'User unblocked.');
});

const listBlocked = asyncHandler(async (req, res) => {
  const rows = await BlockedUser.find({ blocker: req.user._id }).populate('blocked', 'fullName email profilePhoto');
  return ok(res, rows.map((r) => r.blocked));
});

module.exports = { sendMessage, listContacts, listConversations, getThread, markThreadRead, blockUser, unblockUser, listBlocked };
