const crypto=require('crypto');
const family=require('../services/familyAccess.service');
const asyncHandler=require('../utils/asyncHandler');
const AppError=require('../utils/AppError');
const {ok,created}=require('../utils/apiResponse');
const mongoose=require('mongoose');
require('../models/LibraryBook');
const model=n=>require('../models/'+n);
const {notify}=require('../services/notification.service');
async function manager(institution,user){const i=await model('Institution').findById(institution);if(!i)throw new AppError('Institution not found.',404);if(!family.same(i.owner,user._id)&&!i.staff.some(s=>family.same(s.user,user._id)&&(s.permissions||[]).includes('parents:manage')))throw new AppError('Parent management permission required.',403);return i;}
const overview=asyncHandler(async(req,res)=>{
 await family.link(req.user._id,req.params.studentId);
 const student=req.params.studentId;
 const month=String(req.query.month||new Date().toISOString().slice(0,7));if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new AppError('Choose a valid month.',422);
 const start=new Date(month+'-01T00:00:00Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
 const ids=await family.institutions(student);
 const [user,profile,schools,attendance,results,certificates,achievements,loans,behavior,requests]=await Promise.all([
  model('User').findById(student).select('fullName profilePhoto email phone'),model('StudentProfile').findOne({user:student}).select('dateOfBirth rollNumber program currentTerm idCardCode classSection').populate('classSection','name'),
  model('Institution').find({_id:{$in:ids}}).select('name logo address phone email website city country'),
  model('Attendance').find({'records.student':student,date:{$gte:start,$lt:end}}).sort({date:1}).lean(),model('Result').find({student}).populate('institution','name').sort({createdAt:-1}),
  model('Certificate').find({student}).select('title issueDate verifyCode institution').populate('institution','name'),model('Achievement').find({student}).lean(),model('LibraryLoan').find({borrower:student}).populate('book','title author category').lean(),
  model('FamilyObservation').find({student,institution:{$in:ids}}).populate('actor','fullName').sort({createdAt:-1}),model('FamilyConsentRequest').find({student,institution:{$in:ids}}).populate('institution','name').sort({createdAt:-1})
 ]);
 const daily=attendance.map(a=>({date:a.date,institution:a.institution,course:a.course,...a.records.find(r=>family.same(r.student,student))}));
 const totals={present:0,absent:0,late:0,excused:0,half_day:0};daily.forEach(a=>totals[a.status]=(totals[a.status]||0)+1);
 const subjectMap=new Map();for(const r of results){if(!(r.totalMarks>0))continue;const key=[r.institution?._id||r.institution||'',r.course||'',r.subject||'General',r.academicSession||'',r.term||''].join(' / ');const g=subjectMap.get(key)||{institution:r.institution?._id||r.institution,subject:r.subject||'General',session:r.academicSession,term:r.term,obtained:0,total:0};g.obtained+=r.marksObtained;g.total+=r.totalMarks;subjectMap.set(key,g);}const subjects=[...subjectMap.values()].map(g=>({...g,percentage:Math.round(g.obtained/g.total*10000)/100}));
 const timetables=await model('TimetableEntry').find({$or:[...(profile?.classSection?[{classSection:profile.classSection._id}]:[]),{course:{$in:await model('Enrollment').find({student,status:{$ne:'dropped'}}).distinct('course')}}]}).populate('teacher','fullName').populate('institution','name').sort({dayOfWeek:1,startTime:1});
 timetables.sort((a,b)=>['mon','tue','wed','thu','fri','sat','sun'].indexOf(a.dayOfWeek)-['mon','tue','wed','thu','fri','sat','sun'].indexOf(b.dayOfWeek)||a.startTime.localeCompare(b.startTime));
 const ranks=[];const contexts=new Map();for(const r of results)if(r.course){const key=[r.course,r.academicSession,r.term].join(':');if(!contexts.has(key))contexts.set(key,r);}
 for(const r of contexts.values()){
 const cohort=await model('Result').aggregate([{$match:{course:r.course,academicSession:r.academicSession||'',term:r.term||'',totalMarks:{$gt:0}}},{$group:{_id:'$student',obtained:{$sum:'$marksObtained'},total:{$sum:'$totalMarks'}}}]);
 const own=cohort.find(c=>family.same(c._id,student));if(own){const ratio=own.obtained/own.total;ranks.push({institution:r.institution?._id||r.institution,course:r.course,subject:r.subject,session:r.academicSession,term:r.term,rank:1+cohort.filter(c=>c.obtained/c.total>ratio).length,gradedStudents:cohort.length});}}
 const consents=await model('ParentPermission').find({student,parent:req.user._id});
 return ok(res,{student:user,profile,institutions:schools,month,attendance:daily,attendanceTotals:totals,results,ranks,subjects,strong:subjects.filter(s=>s.percentage>=75),weak:subjects.filter(s=>s.percentage<50),certificates,achievements,libraryLoans:loans,behavior,timetable:timetables,consentRequests:requests.map(r=>({...r.toObject(),response:consents.find(c=>family.same(c.request,r._id))||null})),teachers:await family.teachers(student)});
});
const requestConsent=asyncHandler(async(req,res)=>{
 await manager(req.params.institutionId,req.user);if(!(await family.institutions(req.body.studentId)).includes(req.params.institutionId))throw new AppError('Student not enrolled at this institution.',403);
 const {type,title,details,expiresAt,event}=req.body;if(!['trip','event','competition','photo','medical','other'].includes(type)||!String(title||'').trim())throw new AppError('Valid type and title required.',422);
 if(expiresAt&&(!Number.isFinite(new Date(expiresAt).getTime())||new Date(expiresAt)<=new Date()))throw new AppError('Expiry must be in the future.',422);
 if(event&&!await model('InstitutionEvent').exists({_id:event,institution:req.params.institutionId}))throw new AppError('Invalid institution event.',422);
 const row=await model('FamilyConsentRequest').create({institution:req.params.institutionId,student:req.body.studentId,type,title:String(title).trim(),details,expiresAt:expiresAt||null,event:event||null,createdBy:req.user._id});
 const links=await model('ParentChildLink').find({student:row.student,status:'approved',relationship:{$in:['father','mother','guardian']},'permissions.giveConsent':{$ne:false}});
 await Promise.all(links.map(l=>notify(l.parent,{title:'Permission requested: '+row.title,sentBy:req.user._id},{email:true}).catch(()=>{})));return created(res,row);
});
const respondConsent=asyncHandler(async(req,res)=>{
 const request=await model('FamilyConsentRequest').findById(req.params.id);if(!request||request.status!=='open')throw new AppError('Request is not open.',409);
 const link=await family.link(req.user._id,request.student,'giveConsent');if(!['father','mother','guardian'].includes(link.relationship))throw new AppError('A guardian must sign.',403);
 if(!(await family.institutions(request.student)).includes(String(request.institution)))throw new AppError('Institution connection ended.',403);
 if(request.expiresAt&&request.expiresAt<=new Date())throw new AppError('Permission request expired.',409);
 const {decision,signedName}=req.body;if(!['granted','denied'].includes(decision)||!String(signedName||'').trim())throw new AppError('Decision and signature required.',422);
 const row=await model('ParentPermission').findOneAndUpdate({request:request._id,parent:req.user._id},{$set:{student:request.student,institution:request.institution,type:request.type,title:request.title,details:request.details,decision,signedName:String(signedName).trim(),signedAt:new Date()},$push:{history:{decision,signedName:String(signedName).trim(),at:new Date()}}},{upsert:true,new:true,runValidators:true});
 await notify(request.createdBy,{title:'Guardian '+decision+': '+request.title,sentBy:req.user._id}).catch(()=>{});return ok(res,row);
});
const institutionRequests=asyncHandler(async(req,res)=>{await manager(req.params.institutionId,req.user);const rows=await model('FamilyConsentRequest').find({institution:req.params.institutionId}).populate('student','fullName').sort({createdAt:-1});const responses=await model('ParentPermission').find({request:{$in:rows.map(r=>r._id)}}).populate('parent','fullName');return ok(res,rows.map(r=>({...r.toObject(),responses:responses.filter(c=>family.same(c.request,r._id))})));});
const cancelConsent=asyncHandler(async(req,res)=>{const row=await model('FamilyConsentRequest').findById(req.params.id);if(!row)throw new AppError('Not found.',404);await manager(row.institution,req.user);row.status='cancelled';await row.save();return ok(res,row);});
const observation=asyncHandler(async(req,res)=>{
 const {studentId,type,text}=req.body;if(!['progress','behavior','discipline','emergency','achievement'].includes(type)||!String(text||'').trim())throw new AppError('Type and notes required.',422);
 if(!(await family.institutions(studentId)).includes(req.params.institutionId))throw new AppError('Student not enrolled here.',403);
 const isTeacher=(await family.teachers(studentId)).some(r=>family.same(r.teacher,req.user._id)&&r.institutions.some(i=>family.same(i,req.params.institutionId)));if(!isTeacher)await manager(req.params.institutionId,req.user);
 const row=await model('FamilyObservation').create({institution:req.params.institutionId,student:studentId,type,text:String(text).trim(),actor:req.user._id});
 await require('../services/notification.service').notifyParentsOfStudent(studentId,{title:'Child '+type+' update',body:row.text,sentBy:req.user._id},{email:true}).catch(()=>{});return created(res,row);
});
const wallet=asyncHandler(async(req,res)=>{const [balances,transactions]=await Promise.all([model('Wallet').find({user:req.user._id}),model('WalletTransaction').find({user:req.user._id}).select('type amount currency reference status note createdAt').sort({createdAt:-1}).limit(100)]);return ok(res,{balances,transactions});});
const teachingRoster=asyncHandler(async(req,res)=>{
 const courses=await model('Course').find({teacher:req.user._id,institution:{$ne:null}}).select('institution title');
 const rows=await model('Enrollment').find({course:{$in:courses.map(c=>c._id)},status:{$ne:'dropped'}}).populate('student','fullName').select('course student');
 const roster=rows.filter(r=>r.student).map(r=>({student:r.student,institution:courses.find(c=>family.same(c,r.course)).institution,course:courses.find(c=>family.same(c,r.course)).title}));
 const entries=await model('TimetableEntry').find({teacher:req.user._id,classSection:{$ne:null}}).select('classSection institution subject');
 for(const entry of entries){const profiles=await model('StudentProfile').find({classSection:entry.classSection}).populate('user','fullName');for(const p of profiles){if(p.user&&(await family.institutions(p.user._id)).includes(String(entry.institution)))roster.push({student:p.user,institution:entry.institution,course:entry.subject||'Class timetable'});}}
 return ok(res,[...new Map(roster.map(r=>[[r.student._id,r.institution,r.course].join(':'),r])).values()]);
});
const classrooms=asyncHandler(async(req,res)=>{await family.link(req.user._id,req.params.studentId,'observeClassroom');const courses=await model('Enrollment').find({student:req.params.studentId,status:{$ne:'dropped'}}).distinct('course');const sessions=await model('LiveClassSession').find({course:{$in:courses},status:{$in:['scheduled','live']}}).populate('course','title').populate('teacher','fullName').sort({scheduledStart:1});const rows=[];for(const session of sessions){try{await require('../services/guardianObservation.service').authorize(req.user._id,session,req.params.studentId);rows.push({_id:session._id,title:session.title,course:session.course,teacher:session.teacher,mode:session.mode,status:session.status,scheduledStart:session.scheduledStart,scheduledEnd:session.scheduledEnd});}catch(e){if(e.statusCode!==403&&e.statusCode!==422)throw e;}}return ok(res,rows);});
const observationPolicy=asyncHandler(async(req,res)=>{await manager(req.params.institutionId,req.user);if(req.method==='GET'){const row=await model('InstitutionSettings').findOne({institution:req.params.institutionId});return ok(res,{enabled:row?.classroom?.guardianObservationEnabled===true});}if(typeof req.body.enabled!=='boolean')throw new AppError('enabled must be boolean.',422);await model('InstitutionSettings').findOneAndUpdate({institution:req.params.institutionId},{$set:{'classroom.guardianObservationEnabled':req.body.enabled,updatedBy:req.user._id}},{upsert:true,runValidators:true});if(!req.body.enabled)await require('../realtime/socket').revokeInstitutionObservers(req.params.institutionId);return ok(res,{enabled:req.body.enabled});});
module.exports={classrooms,observationPolicy,teachingRoster,overview,requestConsent,respondConsent,institutionRequests,cancelConsent,observation,wallet};
