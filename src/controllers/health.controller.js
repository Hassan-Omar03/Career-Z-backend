const Institution=require('../models/Institution');
const Membership=require('../models/StudentInstitutionMembership');
const Employment=require('../models/TeacherEmployment');
const Profile=require('../models/StudentProfile');
const Incident=require('../models/HealthIncident');
const Link=require('../models/ParentChildLink');
const User=require('../models/User');
const {notify}=require('../services/notification.service');
const AppError=require('../utils/AppError');
const wrap=require('../utils/asyncHandler');
const {ok,created}=require('../utils/apiResponse');
const same=(a,b)=>String(a)===String(b);
async function manager(id,user){const inst=await Institution.findById(id);if(!inst)throw new AppError('Institution not found.',404);if(!same(inst.owner,user)&&!inst.staff.some(s=>same(s.user,user)&&s.permissions.some(p=>['ops:manage','institution:ops:manage','institution:health:manage'].includes(p))))throw new AppError('Health management permission required.',403);return inst;}
async function activeStudent(id,student){if(!await Membership.exists({institution:id,student,status:'active'}))throw new AppError('Student must be an active member of this institution.',403);}
async function guardian(parent,student){if(!await Link.exists({parent,student,status:'approved',relationship:{$in:['father','mother','guardian']},'permissions.viewHealth':true}))throw new AppError('Guardian health permission required.',403);}
const fields=['bloodGroup','allergies','medicalNotes','emergencyContact','vaccinations'];
function normalized(body){const out={};for(const f of fields)if(body[f]!==undefined)out[f]=body[f];
 if(out.bloodGroup!==undefined){out.bloodGroup=String(out.bloodGroup).trim().toUpperCase();if(!['','A+','A-','B+','B-','AB+','AB-','O+','O-'].includes(out.bloodGroup))throw new AppError('Select a valid blood group.',422);}
 if(out.allergies!==undefined&&(!Array.isArray(out.allergies)||out.allergies.some(x=>typeof x!=='string')))throw new AppError('Allergies must be a list of text values.',422);
 if(out.vaccinations!==undefined){if(!Array.isArray(out.vaccinations)||out.vaccinations.some(x=>!x||typeof x.name!=='string'||!x.name.trim()||(x.date&&Number.isNaN(new Date(x.date).getTime()))))throw new AppError('Vaccination name and a valid date are required.',422);out.vaccinations=out.vaccinations.map(x=>({name:x.name.trim(),date:x.date||null,notes:String(x.notes||'')}));}return out;}
async function read(student,inst){const profile=await Profile.findOne({user:student}).select(fields.join(' ')+' healthChanges');const incidents=await Incident.find({student,...(inst?{institution:inst}:{})}).populate('institution','name').sort({occurredAt:-1});return {...Object.fromEntries(fields.map(f=>[f,profile?.[f]??(f==='allergies'||f==='vaccinations'?[]:f==='emergencyContact'?{}:'')])),healthChanges:profile?.healthChanges||[],incidents};}
async function save(student,body,actor){const changes=normalized(body);if(!Object.keys(changes).length)throw new AppError('No health fields provided.',422);return Profile.findOneAndUpdate({user:student},{$set:changes,$push:{healthChanges:{actor,fields:Object.keys(changes),at:new Date()}}},{new:true,upsert:true,runValidators:true});}
async function notifyGuardians(incident,actor){const links=await Link.find({student:incident.student,status:'approved',relationship:{$in:['father','mother','guardian']},'permissions.viewHealth':true});const done=[];for(const link of links){if(incident.notifiedGuardians.some(id=>same(id,link.parent)))continue;try{await notify(link.parent,{title:'Health incident: '+incident.severity,body:incident.description,sentBy:actor},{email:true});done.push(link.parent);}catch{}}
 await Incident.updateOne({_id:incident._id},{$addToSet:{notifiedGuardians:{$each:done}},$set:{parentNotified:incident.notifiedGuardians.length+done.length>0}});return done.length;}
const list=wrap(async(req,res)=>{await manager(req.params.id,req.user._id);return ok(res,await Incident.find({institution:req.params.id}).populate('student','fullName').sort({occurredAt:-1}));});
const create=wrap(async(req,res)=>{
 const inst=req.params.id;let canManage=true;try{await manager(inst,req.user._id);}catch(error){if(error.statusCode!==403)throw error;canManage=false;if(!await Employment.exists({institution:inst,teacher:req.user._id,role:'teacher',status:'active'}))throw error;}
 await activeStudent(inst,req.body.student);if(!String(req.body.description||'').trim())throw new AppError('Incident description required.',422);
 const incident=await Incident.create({institution:inst,student:req.body.student,description:String(req.body.description).trim(),actionTaken:req.body.actionTaken||'',severity:req.body.severity||'minor',occurredAt:req.body.occurredAt||new Date(),recordedBy:req.user._id});
 await notifyGuardians(incident,req.user._id);if(!canManage){const institution=await Institution.findById(inst);await notify(institution.owner,{title:'Teacher reported a health incident',body:'Review the medical and health incident list.',sentBy:req.user._id}).catch(()=>{});}return created(res,await Incident.findById(incident._id),'Health incident recorded.');
});
const record=wrap(async(req,res)=>{let id=req.query?.institution;const profile=await Profile.findOne({user:req.params.userId}).select('primaryInstitution');id=id||profile?.primaryInstitution;if(!id)throw new AppError('Select the student institution.',422);await manager(id,req.user._id);await activeStudent(id,req.params.userId);return ok(res,await read(req.params.userId,id));});
const update=wrap(async(req,res)=>{const profile=await Profile.findOne({user:req.params.userId}).select('primaryInstitution');const id=req.query?.institution||profile?.primaryInstitution;if(!id)throw new AppError('Select the student institution.',422);await manager(id,req.user._id);await activeStudent(id,req.params.userId);await save(req.params.userId,req.body,req.user._id);return ok(res,await read(req.params.userId,id));});
const mine=wrap(async(req,res)=>ok(res,await read(req.user._id)));
const child=wrap(async(req,res)=>{await guardian(req.user._id,req.params.studentId);return ok(res,await read(req.params.studentId));});
const updateChild=wrap(async(req,res)=>{await guardian(req.user._id,req.params.studentId);await save(req.params.studentId,req.body,req.user._id);return ok(res,await read(req.params.studentId));});
const members=wrap(async(req,res)=>{await manager(req.params.id,req.user._id);const ids=await Membership.find({institution:req.params.id,status:'active'}).distinct('student');return ok(res,await User.find({_id:{$in:ids}}).select('fullName'));});
const followUp=wrap(async(req,res)=>{const incident=await Incident.findById(req.params.incidentId);if(!incident)throw new AppError('Incident not found.',404);await manager(incident.institution,req.user._id);
 if(req.body.action==='retry_notification'){await notifyGuardians(incident,req.user._id);return ok(res,await Incident.findById(incident._id));}
 if(!String(req.body.notes||'').trim())throw new AppError('Follow-up notes required.',422);
 if(req.body.status&&!['open','acknowledged','resolved'].includes(req.body.status))throw new AppError('Invalid incident status.',422);
 const status=req.body.status||incident.status;return ok(res,await Incident.findByIdAndUpdate(incident._id,{$set:{status,resolvedAt:status==='resolved'?new Date():null},$push:{followUps:{notes:String(req.body.notes).trim(),actor:req.user._id,at:new Date()}}},{new:true,runValidators:true}));});
const teacher=wrap(async(req,res)=>{const ids=await Employment.find({teacher:req.user._id,role:'teacher',status:'active'}).distinct('institution');const membership=await Membership.find({institution:{$in:ids},status:'active'}).populate('student','fullName').populate('institution','name');return ok(res,{students:membership,incidents:await Incident.find({recordedBy:req.user._id}).select('institution student occurredAt severity description actionTaken status followUps').populate('student','fullName').sort({occurredAt:-1})});});
module.exports={list,create,record,update,mine,child,updateChild,members,followUp,teacher};
