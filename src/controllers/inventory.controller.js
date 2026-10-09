const mongoose = require('mongoose');
const Item = require('../models/InventoryItem');
const Loan = require('../models/InventoryLoan');
const Institution = require('../models/Institution');
const Membership = require('../models/StudentInstitutionMembership');
const {activeStudentInstitutions,isActiveStudent}=require('../utils/activeStudentMembership');
const Employment = require('../models/TeacherEmployment');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const active = ['issued', 'return_requested'];
const same = (a,b) => String(a) === String(b);
const entry = (action, actor, notes = '') => ({ action, actor, notes, at: new Date() });
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min) throw new AppError('Quantity must be a whole number in the allowed range.',422); return value; }
async function manager(id, user) {
 const inst = await Institution.findById(id);
 if (!inst) throw new AppError('Institution not found.',404);
 if (!same(inst.owner,user) && !inst.staff.some(s => same(s.user,user) && s.permissions.some(p => ['ops:manage','institution:ops:manage'].includes(p)))) throw new AppError('Inventory management permission required.',403);
 return inst;
}
async function member(id,user) {
 const inst = await Institution.findById(id);
 if (!inst || !await User.exists({_id:user})) throw new AppError('Member not found.',422);
 if (same(inst.owner,user) || inst.staff.some(s=>same(s.user,user)) || await isActiveStudent(user,id) || await Employment.exists({institution:id,teacher:user,status:'active'})) return;
 throw new AppError('Recipient must be an active member of this institution.',403);
}
async function broadcast(loan,title) { await notify(loan.recipient,{title,body:loan.reason || 'Check your institution inventory.',sentBy:null}).catch(()=>{}); }
const list = asyncHandler(async(req,res)=>{ await manager(req.params.id,req.user._id); return ok(res,await Item.find({institution:req.params.id}).populate('assignedTo','fullName').sort({createdAt:-1})); });
const create = asyncHandler(async(req,res)=>{
 await manager(req.params.id,req.user._id);
 const b=req.body; if (!b.name?.trim()) throw new AppError('Item name required.',422);
 if(b.assignedTo) throw new AppError('Use the issue flow to assign items.',422);
 const item=await Item.create({institution:req.params.id,name:b.name.trim(),category:b.category,quantity:integer(b.quantity ?? 1),location:b.location,condition:b.condition,purchaseDate:b.purchaseDate || null,purchaseCost:b.purchaseCost ?? 0,notes:b.notes,addedBy:req.user._id,history:[entry('created',req.user._id)]});
 return created(res,item,'Item added.');
});
const update = asyncHandler(async(req,res)=>{
 const item=await Item.findById(req.params.itemId); if(!item) throw new AppError('Item not found.',404); await manager(item.institution,req.user._id);
 if(req.body.assignedTo !== undefined && req.body.assignedTo !== null) throw new AppError('Use the inventory issue flow to assign items.',422);
 await mongoose.connection.transaction(async session=>{
  const row=await Item.findById(item._id).session(session);
  if(req.body.assignedTo === null) row.assignedTo=null;
  for(const f of ['name','category','location','condition','purchaseDate','purchaseCost','notes']) if(req.body[f]!==undefined) row[f]=req.body[f];
  if(req.body.quantity!==undefined) row.quantity=integer(req.body.quantity);
  if(req.body.damagedQuantity!==undefined) row.damagedQuantity=integer(req.body.damagedQuantity);
  if(row.quantity < (row.allocatedQuantity || 0)+(row.damagedQuantity || 0)) throw new AppError('Total quantity cannot be less than issued plus damaged stock.',422);
  row.history.push(entry('updated',req.user._id,JSON.stringify(req.body))); await row.save({session});
 }); return ok(res,await Item.findById(item._id),'Item updated.');
});
const remove = asyncHandler(async(req,res)=>{
 const item=await Item.findById(req.params.itemId); if(!item) throw new AppError('Item not found.',404); await manager(item.institution,req.user._id);
 await mongoose.connection.transaction(async session=>{
  const row=await Item.findById(item._id).session(session);
  if(await Loan.exists({item:row._id}).session(session) || row.assignedTo) throw new AppError('Items with assignments or history cannot be deleted; keep the asset record.',409);
  await Item.deleteOne({_id:row._id},{session});
 }); return ok(res,null,'Item removed.');
});
const recipients = asyncHandler(async(req,res)=>{
 const inst=await manager(req.params.id,req.user._id);
 const ids=[inst.owner,...inst.staff.map(s=>s.user),...await Membership.find({institution:inst._id,status:'active'}).distinct('student'),...await Employment.find({institution:inst._id,status:'active'}).distinct('teacher')];
 return ok(res,await User.find({_id:{$in:ids}}).select('fullName email'));
});
const mine = asyncHandler(async(req,res)=>{
 const ids=[...await activeStudentInstitutions(req.user._id),...await Employment.find({teacher:req.user._id,status:'active'}).distinct('institution'),...await Institution.find({$or:[{owner:req.user._id},{'staff.user':req.user._id}]}).distinct('_id')];
 return ok(res,{institutions:await Institution.find({_id:{$in:ids}}).select('name'),items:await Item.find({institution:{$in:ids}}).select('-history -purchaseCost -addedBy -assignedTo').populate('institution','name'),loans:await Loan.find({recipient:req.user._id}).populate('item','name category').populate('institution','name').sort({createdAt:-1}),legacyItems:await Item.find({assignedTo:req.user._id}).populate('institution','name')});
});
const loans = asyncHandler(async(req,res)=>{await manager(req.params.id,req.user._id);return ok(res,await Loan.find({institution:req.params.id}).populate('recipient','fullName').populate('item','name').sort({createdAt:-1}));});
const request = asyncHandler(async(req,res)=>{
 const item=await Item.findById(req.params.itemId);if(!item)throw new AppError('Item not found.',404);await member(item.institution,req.user._id);
 const requested=integer(req.body.quantity,1);
 if(item.assignedTo || ['damaged','needs_repair'].includes(item.condition) || item.quantity-(item.allocatedQuantity || 0)-(item.damagedQuantity || 0)<requested) throw new AppError('Insufficient available stock.',409);
 const loan=await Loan.create({institution:item.institution,item:item._id,recipient:req.user._id,quantity:requested,reason:String(req.body.reason || ''),history:[entry('requested',req.user._id)]});
 const inst=await Institution.findById(item.institution);await notify(inst.owner,{title:'Inventory request',body:item.name,sentBy:req.user._id}).catch(()=>{});return created(res,loan);
});
async function issueStock(itemId,quantity,session,actor) {
 const row=await Item.findById(itemId).session(session);if(!row)throw new AppError('Item not found.',404);
 if(row.assignedTo)throw new AppError('Legacy assignment must be cleared before issuing this item.',409);
 if(['damaged','needs_repair'].includes(row.condition))throw new AppError('Item needs repair before it can be issued.',409);
 if(row.quantity-(row.allocatedQuantity || 0)-(row.damagedQuantity || 0)<quantity)throw new AppError('Insufficient available stock.',409);
 row.allocatedQuantity=(row.allocatedQuantity || 0)+quantity;row.history.push(entry('stock issued',actor));await row.save({session});
}
const issue = asyncHandler(async(req,res)=>{
 const item=await Item.findById(req.params.itemId);if(!item)throw new AppError('Item not found.',404);await manager(item.institution,req.user._id);await member(item.institution,req.body.recipient);
 const quantity=integer(req.body.quantity,1);let loan;
 await mongoose.connection.transaction(async session=>{await issueStock(item._id,quantity,session,req.user._id);[loan]=await Loan.create([{institution:item.institution,item:item._id,recipient:req.body.recipient,quantity,status:'issued',issuedAt:new Date(),dueDate:req.body.dueDate || null,reason:req.body.reason || '',history:[entry('issued',req.user._id)]}],{session});});
 await broadcast(loan,'Inventory item issued to you');return created(res,loan);
});
const action = asyncHandler(async(req,res)=>{
 const original=await Loan.findById(req.params.loanId);if(!original)throw new AppError('Assignment not found.',404);
 const a=req.body.action;const own=same(original.recipient,req.user._id);
 if(['approve','reject','receive'].includes(a))await manager(original.institution,req.user._id);else if(!own)throw new AppError('This assignment is not yours.',403);
 if(a==='approve')await member(original.institution,original.recipient);
 await mongoose.connection.transaction(async session=>{
 const loan=await Loan.findById(original._id).session(session);const state=loan.status;
 if(a==='approve' && state==='pending'){await issueStock(loan.item,loan.quantity,session,req.user._id);loan.status='issued';loan.issuedAt=new Date();loan.dueDate=req.body.dueDate || null;}
 else if(a==='reject' && state==='pending')loan.status='rejected';
 else if(a==='cancel' && state==='pending')loan.status='cancelled';
 else if(a==='return' && state==='issued')loan.status='return_requested';
 else if(a==='damage' && active.includes(state)){if(!String(req.body.notes || '').trim())throw new AppError('Describe the damage.',422);loan.damageReported=true;loan.damageNotes=String(req.body.notes);}
 else if(a==='receive' && active.includes(state)){
  if(!['good','damaged'].includes(req.body.condition))throw new AppError('Specify good or damaged return condition.',422);
  const item=await Item.findById(loan.item).session(session);if(!item || (item.allocatedQuantity || 0)<loan.quantity)throw new AppError('Inventory allocation mismatch.',409);
  item.allocatedQuantity-=loan.quantity;if(req.body.condition==='damaged')item.damagedQuantity=(item.damagedQuantity || 0)+loan.quantity;
  item.history.push(entry('returned '+req.body.condition,req.user._id));await item.save({session});loan.status='returned';loan.returnedAt=new Date();
 }else throw new AppError('Action is not valid for the current assignment status.',409);
 loan.history.push(entry(a,req.user._id,String(req.body.notes || '')));await loan.save({session});
 });const result=await Loan.findById(original._id);await broadcast(result,'Inventory: '+a);
 if(['return','damage','cancel'].includes(a)){const inst=await Institution.findById(result.institution);await notify(inst.owner,{title:'Inventory: '+a,body:String(req.body.notes || 'Check inventory requests and assignments.'),sentBy:req.user._id}).catch(()=>{});}
 return ok(res,result);
});
module.exports={list,create,update,remove,recipients,mine,loans,request,issue,action};
