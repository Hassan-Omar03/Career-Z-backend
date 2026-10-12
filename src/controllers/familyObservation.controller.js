const asyncHandler=require('../utils/asyncHandler');
const AppError=require('../utils/AppError');
const {ok}=require('../utils/apiResponse');
const family=require('../services/familyAccess.service');
const Observation=require('../models/FamilyObservation');
const model=n=>require('../models/'+n);
const {notify}=require('../services/notification.service');
async function staffAccess(row,user){
 const student=row.student?._id||row.student,institution=row.institution?._id||row.institution;
 if(!(await family.institutions(student)).includes(String(institution)))throw new AppError('Student institution relationship ended.',403);
 const school=await model('Institution').findById(institution);
 const manager=school&&(family.same(school.owner,user._id)||school.staff.some(s=>family.same(s.user,user._id)&&(s.permissions||[]).includes('parents:manage')));
 const teacher=family.same(row.actor,user._id)&&(await family.teachers(student)).some(t=>family.same(t.teacher,user._id)&&t.institutions.some(i=>family.same(i,institution)));
 if(!manager&&!teacher)throw new AppError('Only the reporting teacher or authorized school reviewer may follow up.',403);
}
async function decorate(rows,userId){return Promise.all(rows.map(async row=>{const data=row.toObject();data.acknowledgedByMe=!!userId&&(row.history||[]).some(h=>h.action==='acknowledged'&&family.same(h.actor,userId));data.meetings=await model('ParentTeacherMeeting').find({observation:row._id}).select('parent teacher requestedDate confirmedDate status subject').populate('parent','fullName');data.hasActiveMeetingByMe=!!userId&&data.meetings.some(m=>family.same(m.parent,userId)&&['pending','confirmed'].includes(m.status));return data;}));}
const staffList=asyncHandler(async(req,res)=>{
 let query;
 if(req.query.institutionId){const school=await model('Institution').findById(req.query.institutionId);if(!school||(!family.same(school.owner,req.user._id)&&!school.staff.some(s=>family.same(s.user,req.user._id)&&(s.permissions||[]).includes('parents:manage'))))throw new AppError('School parent management permission required.',403);query={institution:school._id,student:{$in:await family.students(school._id)}};}
 else query={actor:req.user._id};
 const rows=await Observation.find(query).populate('student','fullName').populate('actor','fullName').populate('institution','name').populate('history.actor','fullName').sort({createdAt:-1}).limit(200);
 const allowed=[];for(const row of rows){try{await staffAccess(row,req.user);allowed.push(row);}catch(e){if(e.statusCode!==403)throw e;}}
 return ok(res,await decorate(allowed));
});
const respond=asyncHandler(async(req,res)=>{
 const row=await Observation.findById(req.params.id);if(!row)throw new AppError('Update not found.',404);
 const {action}=req.body;const text=String(req.body.text||'').trim();if(text.length>5000)throw new AppError('Maximum 5000 characters.',422);
 const parentAction=['acknowledged','parent_reply'].includes(action);
 if(parentAction)await family.requireSchoolVerification(req.user._id,row.student,row.institution);else{if(!['follow_up','resolved','reopened'].includes(action))throw new AppError('Invalid action.',422);await staffAccess(row,req.user);}
 if(action!=='acknowledged'&&!text)throw new AppError('Write the action or follow-up details.',422);
 const status=row.status||'open';
 if(status==='resolved'&&action!=='reopened')throw new AppError('This complaint is resolved. The teacher must reopen it before further action.',409);
 if(action==='reopened'&&status!=='resolved')throw new AppError('Only resolved complaints can be reopened.',409);
 const filter={_id:row._id};
 if(action==='acknowledged')filter.history={$not:{$elemMatch:{actor:req.user._id,action:'acknowledged'}}};
 if(action==='reopened')filter.status='resolved';else filter.status={$ne:'resolved'};
 const update={$push:{history:{actor:req.user._id,action,text,at:new Date()}}};
 if(action==='parent_reply')update.$set={status:'awaiting_teacher'};
 if(action==='resolved')update.$set={status:'resolved'};
 if(action==='reopened')update.$set={status:'open'};
 const saved=await Observation.findOneAndUpdate(filter,update,{new:true,runValidators:true});if(!saved)throw new AppError('Already acknowledged or status changed. Refresh the update.',409);
 if(parentAction)await notify(row.actor,{title:'Guardian '+action.replace('_',' '),body:text||'Guardian has seen the child update.',sentBy:req.user._id}).catch(()=>{});
 else{const links=await model('ParentChildLink').find({student:row.student,status:'approved'});for(const link of links)if((await family.verifiedInstitutions(link)).includes(String(row.institution)))await notify(link.parent,{title:'Teacher '+action.replace('_',' '),body:text,sentBy:req.user._id}).catch(()=>{});}
 return ok(res,saved);
});
module.exports={staffAccess,decorate,staffList,respond};
