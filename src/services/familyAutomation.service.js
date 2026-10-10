const Link=require('../models/ParentChildLink');
const Attendance=require('../models/Attendance');
const Result=require('../models/Result');
const Meeting=require('../models/ParentTeacherMeeting');
const Alert=require('../models/FamilyAlert');
const family=require('./familyAccess.service');
const {notify}=require('./notification.service');
// A recipient-specific unique key prevents routine scheduler runs from repeating an alert.
// Unsent claims expire after five minutes so a failed worker can be retried.
async function once(key,student,kind,user,payload,now){
 try{await Alert.create({key,student,kind});}catch(e){if(e.code!==11000)throw e;}
 const claim=await Alert.findOneAndUpdate({key,delivered:false,$or:[{lockedUntil:{$exists:false}},{lockedUntil:null},{lockedUntil:{$lt:now}}]},{$set:{lockedUntil:new Date(now.getTime()+300000)}},{new:true});
 if(!claim)return false;
 try{await notify(user,payload,{email:true});await Alert.updateOne({_id:claim._id},{$set:{delivered:true,lockedUntil:null}});return true;}catch(e){await Alert.updateOne({_id:claim._id},{$set:{lockedUntil:null}});throw e;}
}
async function runFamilyAutomation(now=new Date()){
 let sent=0;
 const links=await Link.find({status:'approved'});
 const byStudent=new Map();for(const l of links){const key=String(l.student);if(!byStudent.has(key))byStudent.set(key,[]);byStudent.get(key).push(l.parent);}
 const since=new Date(now.getTime()-7*86400000);
 for(const [student,parents] of byStudent){
  const sheets=await Attendance.find({'records.student':student,date:{$gte:since,$lte:now}}).sort({date:1});
  const days=[...new Set(sheets.filter(a=>a.records.some(r=>family.same(r.student,student)&&r.status==='absent')).map(a=>a.date.toISOString().slice(0,10)))];
  if(days.length>=3){for(const parent of parents)sent+=await once(`absence:${student}:${days.at(-1)}:${parent}`,student,'repeated_absence',parent,{title:'Repeated absence: please contact the institution',body:`Your child was absent on ${days.length} days in the last seven days.`},now)?1:0;}
  for(const institution of await family.institutions(student)){const policy=await require('../models/InstitutionSettings').findOne({institution});const threshold=policy?.family?.dropoutAbsenceDays||10;const monthSheets=await Attendance.find({institution,'records.student':student,date:{$gte:new Date(now.getTime()-30*86400000),$lte:now}});const absent=[...new Set(monthSheets.filter(a=>a.records.some(r=>family.same(r.student,student)&&r.status==='absent')).map(a=>a.date.toISOString().slice(0,10)))];if(absent.length>=threshold){const school=await require('../models/Institution').findById(institution);for(const user of [...parents,...(school?[school.owner]:[])])sent+=await once('dropout:'+student+':'+institution+':'+now.toISOString().slice(0,7)+':'+user,student,'dropout_warning',user,{title:'Persistent absence: support plan needed',body:'Recorded absence reached '+absent.length+' days in 30 days. Please arrange a support meeting; this is a warning, not a dropout decision.'},now)?1:0;}}
  const results=await Result.find({student,createdAt:{$gte:since,$lte:now},totalMarks:{$gt:0}});
  for(const r of results.filter(r=>r.marksObtained/r.totalMarks<0.5))for(const parent of parents)sent+=await once(`result:${r._id}:${parent}`,student,'low_marks',parent,{title:'Learning support recommended',body:`${r.subject||'Assessment'}: ${r.marksObtained}/${r.totalMarks}. Discuss a support plan with the teacher.`},now)?1:0;
 }
 const meetings=await Meeting.find({status:'confirmed',confirmedDate:{$gte:now,$lte:new Date(now.getTime()+24*3600000)}});
 for(const m of meetings){if(!await Link.exists({parent:m.parent,student:m.student,status:'approved'}))continue;if(!(await family.teachers(m.student)).some(t=>family.same(t.teacher,m.teacher)))continue;for(const user of [m.parent,m.teacher])sent+=await once(`ptm:${m._id}:${m.confirmedDate.toISOString()}:${user}`,m.student,'ptm_reminder',user,{title:'Parent–teacher meeting reminder',body:m.confirmedDate.toISOString()},now)?1:0;}
 const expired=await Meeting.find({status:{$in:['pending','expired']},requestedDate:{$lt:now}});for(const m of expired){const row=await Meeting.findOneAndUpdate({_id:m._id,status:'pending'},{$set:{status:'expired'}});if(!row&&m.status!=='expired')continue;for(const user of [m.parent,m.teacher])sent+=await once('ptm-expired:'+m._id+':'+user,m.student,'ptm_expired',user,{title:'Meeting request expired without confirmation',body:'Choose a new time with the teacher.'},now)?1:0;}
 return {sent};
}
module.exports={runFamilyAutomation};
