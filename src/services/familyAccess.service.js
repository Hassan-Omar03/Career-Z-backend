const Link=require('../models/ParentChildLink');
const Profile=require('../models/StudentProfile');
const Membership=require('../models/StudentInstitutionMembership');
const Institution=require('../models/Institution');
const Course=require('../models/Course');
const Enrollment=require('../models/Enrollment');
const Timetable=require('../models/TimetableEntry');
const AppError=require('../utils/AppError');
const same=(a,b)=>String(a?._id||a||'')===String(b?._id||b||'');
async function institutions(student){const [p,all]=await Promise.all([Profile.findOne({user:student}).select('primaryInstitution'),Membership.find({student}).select('institution status')]);const ids=all.filter(m=>['active','withdrawal_requested','transfer_requested'].includes(m.status)).map(m=>String(m.institution));if(p?.primaryInstitution&&!all.some(m=>same(m.institution,p.primaryInstitution)))ids.push(String(p.primaryInstitution));return [...new Set(ids)];}
async function students(institution){const [members,profiles]=await Promise.all([Membership.find({institution,status:{$in:['active','withdrawal_requested','transfer_requested']}}).distinct('student'),Profile.find({primaryInstitution:institution}).distinct('user')]);const ids=new Set(members.map(String));for(const id of profiles){if(!(await Membership.exists({student:id,institution})))ids.add(String(id));}return [...ids];}
async function link(parent,student,permission){const row=await Link.findOne({parent,student,status:'approved'});if(!row)throw new AppError('You are not linked to this student.',403);if(permission&&row.permissions?.[permission]===false)throw new AppError('Guardian permission is restricted.',403);return row;}
async function teachers(student){const [profile,courses]=await Promise.all([Profile.findOne({user:student}),Enrollment.find({student,status:{$ne:'dropped'}}).populate({path:'course',populate:{path:'teacher',select:'fullName email profilePhoto'}})]);const entries=profile?.classSection?await Timetable.find({classSection:profile.classSection,institution:{$in:await institutions(student)}}).populate('teacher','fullName email profilePhoto'):[];const map=new Map();function add(teacher,subject,institution){if(!teacher?._id)return;const id=String(teacher._id);if(!map.has(id))map.set(id,{teacher,subjects:[],institution,institutions:[]});const r=map.get(id);if(institution&&!r.institutions.some(i=>same(i,institution)))r.institutions.push(institution);if(subject&&!r.subjects.includes(subject))r.subjects.push(subject);}entries.forEach(e=>add(e.teacher,e.subject,e.institution));courses.forEach(e=>add(e.course?.teacher,e.course?.subject||e.course?.title,e.course?.institution));return [...map.values()];}
async function contacts(parent){const children=await Link.find({parent,status:'approved'}).distinct('student');const map=new Map();for(const student of children){for(const row of await teachers(student))map.set(String(row.teacher._id),{user:row.teacher,relationship:'teacher',context:row.subjects.join(', ')});for(const id of await institutions(student)){const i=await Institution.findById(id).populate('owner','fullName email roles profilePhoto').populate('staff.user','fullName email roles profilePhoto');if(!i)continue;for(const u of [i.owner,...i.staff.filter(s=>s.role!=='teacher'&&!['driver','warden'].includes(s.role)).map(s=>s.user)])if(u?._id)map.set(String(u._id),{user:u,relationship:'institution',context:i.name});}}return [...map.values()];}
async function groupContacts(parent){const groups=await require('../models/GroupConversation').find({institution:{$ne:null},participants:parent}).populate('participants','fullName email roles profilePhoto');const rows=[];for(const group of groups){if(!await require('./guardianGroupAccess.service').eligible(group,parent))continue;for(const user of group.participants)if(!same(user,parent)&&await require('./guardianGroupAccess.service').eligible(group,user))rows.push({user,relationship:'parent group',context:group.name});}return rows;}
async function related(parent,other){return (await contacts(parent)).some(c=>same(c.user,other));}
function safeFee(fee){const f=fee.toObject?fee.toObject():{...fee};for(const k of ['platformCommission','netAmount','commissionPercent','commissionPercentage','grossAmount','escrowStatus','escrowReleasedAt'])delete f[k];if(Array.isArray(f.paymentHistory))f.paymentHistory=f.paymentHistory.map(p=>{const r={...p};for(const k of ['platformCommission','netAmount','commissionPercent'])delete r[k];return r;});return f;}
async function assertInstitutionAccess(user,institution){
 const school=await Institution.findById(institution);if(!school)throw new AppError('Institution not found.',404);
 if(same(school.owner,user)||school.staff.some(s=>same(s.user,user)))return;
 if((await institutions(user)).includes(String(institution)))return;
 const children=await Link.find({parent:user,status:'approved'}).distinct('student');
 for(const child of children)if((await institutions(child)).includes(String(institution)))return;
 throw new AppError('You are not connected to this institution.',403);
}
module.exports={groupContacts,assertInstitutionAccess,institutions,students,link,teachers,contacts,related,safeFee,same};
