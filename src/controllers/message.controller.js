const Message = require('../models/Message');
const User = require('../models/User');
const { notify } = require('../services/notification.service');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// POST /api/messages
const sendMessage = asyncHandler(async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) throw new AppError('to and text are required.', 422);
  if (to === req.user._id.toString()) throw new AppError('You cannot message yourself.', 422);

  const recipient = await User.findById(to);
  if (!recipient) throw new AppError('Recipient not found.', 404);

  const message = await Message.create({ from: req.user._id, to, text });

  notify(to, { title: `New message from ${req.user.fullName}`, body: text.slice(0, 140), sentBy: req.user._id }).catch(() => {});

  return created(res, message, 'Message sent.');
});

// GET /api/messages/conversations — one row per person you've exchanged messages with
const listConversations = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const messages = await Message.find({ $or: [{ from: userId }, { to: userId }] })
    .sort({ createdAt: -1 })
    .populate('from', 'fullName email')
    .populate('to', 'fullName email');

  const seen = new Map();
  for (const m of messages) {
    const other = m.from._id.toString() === userId.toString() ? m.to : m.from;
    const key = other._id.toString();
    if (!seen.has(key)) {
      seen.set(key, {
        user: other,
        lastMessage: m.text,
        lastAt: m.createdAt,
        unread: 0
      });
    }
    if (m.to._id.toString() === userId.toString() && !m.read) {
      seen.get(key).unread += 1;
    }
  }

  return ok(res, Array.from(seen.values()));
});

// GET /api/messages/with/:userId — full thread with one person
const getThread = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const otherId = req.params.userId;

  const thread = await Message.find({
    $or: [
      { from: userId, to: otherId },
      { from: otherId, to: userId }
    ]
  }).sort({ createdAt: 1 });

  return ok(res, thread);
});

// PATCH /api/messages/with/:userId/read — mark all messages from that person as read
const markThreadRead = asyncHandler(async (req, res) => {
  await Message.updateMany({ from: req.params.userId, to: req.user._id, read: false }, { $set: { read: true } });
  return ok(res, { marked: true });
});

module.exports = { sendMessage, listConversations, getThread, markThreadRead };
