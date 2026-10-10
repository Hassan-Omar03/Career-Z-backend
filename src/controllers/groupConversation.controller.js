const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const { canCommunicate, operationalStaffScope } = require('../utils/messageAccess');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { emitToUser, broadcastGroupMessage } = require('../realtime/socket');

function isMember(group, userId) {
  return group.participants.some((p) => (p._id || p).toString() === userId.toString());
}

async function assertGroupsAllowed(userId) {
  if (await operationalStaffScope(userId)) {
    throw new AppError('Wardens and drivers cannot use group conversations.', 403);
  }
}

// POST /api/group-conversations — every named member must already be a valid 1:1 contact of the
// creator (same rule as canCommunicate), so a group can't be used to reach someone otherwise
// unreachable. Blocked pairs are silently skipped rather than failing the whole group creation.
const createGroup = asyncHandler(async (req, res) => {
  await assertGroupsAllowed(req.user._id);
  const { name, memberIds } = req.body;
  if (!name || !Array.isArray(memberIds) || memberIds.length < 2) {
    throw new AppError('name and at least 2 other members are required.', 422);
  }
  if(memberIds.some(id=>!require('mongoose').isValidObjectId(id)))throw new AppError('Choose valid contacts.',422);
  const allowed = [];
  for (const id of [...new Set(memberIds.map(String))]) {
    if (id === req.user._id.toString()) continue;
    if (await canCommunicate(req.user._id, id)) allowed.push(id);
  }
  if (allowed.length < 2) throw new AppError('At least 2 valid contacts are required to start a group.', 422);

  let institution=req.body.institution||null;
  const family=require('../services/familyAccess.service');
  const schools=await require('../models/Institution').find({$or:[{owner:req.user._id},{staff:{$elemMatch:{user:req.user._id,permissions:'parents:manage'}}}]});
  if(institution&&!schools.some(i=>family.same(i,institution)))throw new AppError('Guardian group management permission required.',403);
  const parents=await require('../models/ParentChildLink').find({parent:{$in:allowed},status:'approved'});
  for(const school of schools){const students=new Set(await family.students(school._id));if(allowed.every(id=>parents.some(p=>String(p.parent)===id&&students.has(String(p.student))))){institution=institution||school._id;break;}}
  if(institution){const students=new Set(await family.students(institution));if(!allowed.every(id=>parents.some(p=>String(p.parent)===id&&students.has(String(p.student)))))throw new AppError('All guardian group members must be linked to active students here.',403);}
  const group = await GroupConversation.create({ institution,name, createdBy: req.user._id, participants: [req.user._id, ...allowed] });
  const populated = await group.populate('participants', 'fullName profilePhoto');
  allowed.forEach((id) => emitToUser(id, 'group:invited', { groupId: group.id, name }));
  return created(res, populated, 'Group created.');
});

// GET /api/group-conversations/mine
const myGroups = asyncHandler(async (req, res) => {
  if (await operationalStaffScope(req.user._id)) return ok(res, []);
  const groups = await GroupConversation.find({ participants: req.user._id }).populate('participants', 'fullName profilePhoto').sort({ updatedAt: -1 });
  const visible=[];for(const g of groups)if(await require('../services/guardianGroupAccess.service').eligible(g,req.user._id))visible.push(g);return ok(res,visible);
});

// GET /api/group-conversations/:id/messages
const listMessages = asyncHandler(async (req, res) => {
  await assertGroupsAllowed(req.user._id);
  const group = await GroupConversation.findById(req.params.id);
  if (!group) throw new AppError('Group not found.', 404);
  if (!await require('../services/guardianGroupAccess.service').eligible(group,req.user._id)) throw new AppError('You are not a member of this group.', 403);
  const messages = await GroupMessage.find({ conversation: group._id }).populate('from', 'fullName profilePhoto').sort({ createdAt: 1 });
  const blocked=await require('../models/BlockedUser').find({$or:[{blocker:req.user._id},{blocked:req.user._id}]});const hidden=new Set(blocked.map(b=>String(String(b.blocker)===String(req.user._id)?b.blocked:b.blocker)));return ok(res,messages.filter(m=>!hidden.has(String(m.from?._id||m.from))));
});

// POST /api/group-conversations/:id/messages
const sendMessage = asyncHandler(async (req, res) => {
  await assertGroupsAllowed(req.user._id);
  const { text, attachments = [] } = req.body;
  await require('../services/chatSafety.service').validate(text);
  
  const group = await GroupConversation.findById(req.params.id);
  if (!group) throw new AppError('Group not found.', 404);
  if (!await require('../services/guardianGroupAccess.service').eligible(group,req.user._id)) throw new AppError('You are not a member of this group.', 403);

  const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 5).map((item) => ({ name: String(item?.name || 'Attachment').slice(0, 150), url: String(item?.url || ''), type: String(item?.type || '').slice(0, 100) })).filter((item) => /^https:\/\//i.test(item.url)) : [];
  if(!text?.trim()&&!safeAttachments.length)throw new AppError('A message or valid attachment is required.',422);
  const message = await GroupMessage.create({ conversation: group._id, from: req.user._id, text: text?.trim()||'[Attachment]', attachments: safeAttachments });
  const populated = await message.populate('from', 'fullName profilePhoto');
  await broadcastGroupMessage(group.id, populated);
  return created(res, populated, 'Sent.');
});

// PATCH /api/group-conversations/:id/leave
const leaveGroup = asyncHandler(async (req, res) => {
  const group = await GroupConversation.findById(req.params.id);
  if (!group) throw new AppError('Group not found.', 404);
  group.participants = group.participants.filter((p) => p.toString() !== req.user._id.toString());
  await group.save();
  return ok(res, null, 'Left group.');
});

module.exports = { createGroup, myGroups, listMessages, sendMessage, leaveGroup };
