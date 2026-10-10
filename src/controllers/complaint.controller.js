const Complaint = require('../models/Complaint');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// targetId isn't a typed ref (targetType decides which collection it points to), so it
// can't be populate()'d directly — this batch-fetches the 'user' targets for a page of
// complaints in one query instead of one lookup per row.
async function attachUserTargets(complaints) {
  const userTargetIds = complaints.filter((c) => c.targetType === 'user' && c.targetId).map((c) => c.targetId);
  if (userTargetIds.length === 0) return complaints.map((c) => ({ ...c.toObject(), target: null }));

  const users = await User.find({ _id: { $in: userTargetIds } }).select('fullName email phone roles');
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return complaints.map((c) => ({
    ...c.toObject(),
    target: c.targetType === 'user' && c.targetId ? byId.get(String(c.targetId)) || null : null
  }));
}

// POST /api/complaints
const createComplaint = asyncHandler(async (req, res) => {
  const { subject, category, description, targetType, targetId } = req.body;
  if (!subject || !description) throw new AppError('subject and description are required.', 422);

  if (targetType === 'user' && targetId) {
    const targetUser = await User.findById(targetId).select('_id');
    if (!targetUser) throw new AppError('The selected person could not be found.', 404);
  }

  const ids=req.body.messageIds||[],groupIds=req.body.groupMessageIds||[];
  if(!Array.isArray(ids)||!Array.isArray(groupIds)||ids.length+groupIds.length>20||[...ids,...groupIds].some(id=>!require('mongoose').isValidObjectId(id)))throw new AppError('Choose up to 20 valid messages as complaint evidence.',422);
  const evidence=[];
  if(ids.length){const messages=await require('../models/Message').find({_id:{$in:ids},$or:[{from:req.user._id},{to:req.user._id}]});if(messages.length!==new Set(ids).size)throw new AppError('You can only report messages from your own conversation.',403);for(const m of messages){if(targetType==='user'&&targetId&&![String(m.from),String(m.to)].includes(String(targetId)))throw new AppError('Evidence does not belong to the reported person.',422);evidence.push({messageId:m._id,kind:'direct',from:m.from,to:m.to,text:m.text,attachments:m.attachments,sentAt:m.createdAt});}}
  if(groupIds.length){const messages=await require('../models/GroupMessage').find({_id:{$in:groupIds}});if(messages.length!==new Set(groupIds).size)throw new AppError('Message evidence not found.',404);for(const m of messages){const group=await require('../models/GroupConversation').findById(m.conversation);if(!group||!await require('../services/guardianGroupAccess.service').eligible(group,req.user._id))throw new AppError('This is not your accessible group conversation.',403);if(targetType==='user'&&targetId&&String(m.from)!==String(targetId))throw new AppError('Evidence does not belong to the reported person.',422);evidence.push({messageId:m._id,kind:'group',from:m.from,conversation:m.conversation,text:m.text,attachments:m.attachments,sentAt:m.createdAt});}}
  const complaint = await Complaint.create({messageEvidence:evidence,
    submittedBy: req.user._id,
    subject,
    category: category || 'other',
    description,
    targetType: targetType || 'none',
    targetId: targetId || null
  });

  return created(res, complaint, 'Complaint submitted.');
});

// GET /api/complaints/mine
const myComplaints = asyncHandler(async (req, res) => {
  const complaints = await Complaint.find({ submittedBy: req.user._id }).sort({ createdAt: -1 });
  return ok(res, await attachUserTargets(complaints));
});

// GET /api/complaints (admin)
const listComplaints = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;
  const complaints = await Complaint.find(filter)
    .populate('submittedBy', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, await attachUserTargets(complaints));
});

// PATCH /api/complaints/:id (admin)
const updateComplaintStatus = asyncHandler(async (req, res) => {
  const { status, resolutionNotes } = req.body;
  if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) throw new AppError('Complaint not found.', 404);

  complaint.status = status;
  complaint.resolutionNotes = resolutionNotes || complaint.resolutionNotes;
  if (status === 'resolved' || status === 'dismissed') {
    complaint.resolvedBy = req.user._id;
    complaint.resolvedAt = new Date();
  }
  await complaint.save();
  return ok(res, complaint, `Complaint ${status}.`);
});

module.exports = { createComplaint, myComplaints, listComplaints, updateComplaintStatus };
