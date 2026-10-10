const family=require('./familyAccess.service'),AppError=require('../utils/AppError');
async function authorize(parent,sessionId,student){
 const session=typeof sessionId==='object'&&sessionId.course?sessionId:await require('../models/LiveClassSession').findById(sessionId);if(!session)throw new AppError('Class not found.',404);
 const link=await family.link(parent,student,'observeClassroom');if(!['father','mother','guardian'].includes(link.relationship))throw new AppError('A guardian link is required for classroom observation.',403);
 if(!(await family.institutions(student)).includes(String(session.institution)))throw new AppError('Institution connection ended.',403);
 const settings=await require('../models/InstitutionSettings').findOne({institution:session.institution});if(settings?.classroom?.guardianObservationEnabled!==true)throw new AppError('Institution has not enabled guardian classroom observation.',403);
 if(!await require('../models/Enrollment').exists({student,course:session.course,status:{$ne:'dropped'}}))throw new AppError('Child is not enrolled in this class.',403);
 if(session.mode==='physical'||session.provider==='external')throw new AppError('Read-only observation requires a CareerZ online classroom.',422);
 return session;
}
function receiveOnly(description){if(!description)return true;const parts=String(description.sdp||'').split(/(?:\r?\n|^)m=/).slice(1);return parts.length>0&&parts.every(p=>/(?:^|\r?\n)a=(?:recvonly|inactive)(?:\r?\n|$)/.test(p)&&!/(?:^|\r?\n)a=(?:sendrecv|sendonly)(?:\r?\n|$)/.test(p));}
module.exports={authorize,receiveOnly};
