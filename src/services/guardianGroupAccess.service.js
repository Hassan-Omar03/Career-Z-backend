const family=require('./familyAccess.service');
const Institution=require('../models/Institution'),Link=require('../models/ParentChildLink');
async function eligible(group,user){
 if(!group.participants.some(p=>family.same(p,user)))return false;
 if(!group.institution){if(family.same(group.createdBy,user))return true;return require('../utils/messageAccess').canCommunicate(user,group.createdBy);}
 const school=await Institution.findById(group.institution);if(!school)return false;
 if(family.same(school.owner,user)||school.staff.some(s=>family.same(s.user,user)&&(s.permissions||[]).includes('parents:manage')))return true;
 const children=await Link.find({parent:user,status:'approved'}).distinct('student');
 for(const child of children)if((await family.institutions(child)).includes(String(group.institution)))return true;
 return false;
}
module.exports={eligible};
