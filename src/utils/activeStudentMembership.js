const Membership=require('../models/StudentInstitutionMembership');
const Profile=require('../models/StudentProfile');
// Explicit membership states take precedence over legacy primaryInstitution links.
async function activeStudentInstitutions(student){
 const rows=await Membership.find({student}).select('institution status');
 const ids=rows.filter(row=>row.status==='active').map(row=>row.institution);
 const profile=await Profile.findOne({user:student,status:'active'}).select('primaryInstitution');
 if(profile?.primaryInstitution&&!rows.some(row=>String(row.institution)===String(profile.primaryInstitution)))ids.push(profile.primaryInstitution);
 return ids;
}
async function isActiveStudent(student,institution){return (await activeStudentInstitutions(student)).some(id=>String(id)===String(institution));}
module.exports={activeStudentInstitutions,isActiveStudent};
