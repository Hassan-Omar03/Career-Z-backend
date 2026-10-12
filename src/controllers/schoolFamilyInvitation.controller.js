const family=require('../services/familyAccess.service'),Link=require('../models/ParentChildLink'),User=require('../models/User'),Institution=require('../models/Institution'),Profile=require('../models/StudentProfile'),wrap=require('../utils/asyncHandler'),AppError=require('../utils/AppError'),{created}=require('../utils/apiResponse'),{notify}=require('../services/notification.service');
module.exports=wrap(async(req,res)=>{
 const school=await Institution.findById(req.params.institutionId);if(!school)throw new AppError('Institution not found.',404);
 require('./staffPermission.controller').assertOwnerOrPermission(school,req.user._id,'parents:manage');
 let student=req.body.studentId;
 if(!student){const roll=String(req.body.admissionNumber||'').trim();if(!roll)throw new AppError('Choose student or enter admission/roll number.',422);const ids=await family.students(school._id);const matches=await Profile.find({user:{$in:ids},rollNumber:roll}).select('user');if(matches.length!==1)throw new AppError('Admission number must identify one current student at this school.',422);student=matches[0].user;}
 if(!(await family.institutions(student)).includes(String(school._id)))throw new AppError('Student is not enrolled at this school.',403);
 const profile=await Profile.findOne({user:student});const contact=profile?.parentEmail;
 if(!contact)throw new AppError('Student must add their parent email in their profile before the school can invite.',422);
 if(req.body.parentEmail&&String(req.body.parentEmail).trim().toLowerCase()!==contact)throw new AppError('Use the parent email supplied by this student, not another address.',422);
 const child=await User.findById(student),parent=await User.findOne({email:contact,status:'active',roles:'parent'});
 if(!parent||!child||child.status!=='active'||!child.roles.includes('student'))throw new AppError('Active parent and student accounts are required.',422);
 const relationship=profile.parentRelationship||'guardian';if(!['father','mother','guardian'].includes(relationship))throw new AppError('Select father, mother or guardian.',422);
 const previous=await Link.findOne({parent:parent._id,student});if(previous&&!['revoked','rejected'].includes(previous.status))throw new AppError('A family connection already exists. Review its approval and documents.',409);
 const values={parent:parent._id,student,relationship,status:'pending',requestedBy:req.user._id,invitationInstitution:school._id,schoolParentAccepted:false,schoolStudentAccepted:false,approvedAt:null,institutionVerifications:[],institutionVerified:false,permissions:{payFees:true,viewHealth:true,giveConsent:true,observeClassroom:true}};
 const row=previous?await Link.findOneAndUpdate({_id:previous._id,status:{$in:['revoked','rejected']}},{$set:values,$push:{lifecycleHistory:{action:'school_invited',actor:req.user._id,at:new Date()}}},{new:true,runValidators:true}):await Link.create({...values,lifecycleHistory:[{action:'school_invited',actor:req.user._id,at:new Date()}]});
 if(!row)throw new AppError('Connection changed. Refresh and try again.',409);
 await Promise.all([parent._id,child._id].map(id=>notify(id,{title:'School family invitation',body:school.name+' invited you to approve a family connection. Both accounts must accept; school document verification follows.',sentBy:req.user._id}).catch(()=>{})));
 return created(res,row,'Invitation sent to parent and student. Both must accept.');
});
