require('dotenv').config();
const mongoose=require('mongoose');
const connectDB=require('../config/db');
const env=require('../config/env');
const User=require('../models/User');
const Institution=require('../models/Institution');
const Profile=require('../models/StudentProfile');
const Membership=require('../models/StudentInstitutionMembership');
async function run(){
 if(env.useMemoryDb)throw new Error('Standalone seed cannot update an already-running in-memory database. Use the persistent local database.');
 await connectDB();
 const student=await User.findOne({email:'baitcvs@gmail.com'});
 const institution=await Institution.findOne({slug:'gcuf'});
 if(!student||!institution)throw new Error('Existing Mohammad Omar/GCUF test records were not found.');
 const profile=await Profile.findOne({user:student._id});
 if(!profile)throw new Error('Existing student profile not found.');
 const before=await Membership.findOne({student:student._id,institution:institution._id});
 console.log(JSON.stringify({email:student.email,institution:institution.name,before:{profile:profile.status,membership:before?.status||'missing'}}));
 await mongoose.connection.transaction(async session=>{
  await Profile.updateOne({_id:profile._id},{$set:{status:'active',primaryInstitution:institution._id}},{session,runValidators:true});
  await Membership.updateMany({student:student._id,institution:{$ne:institution._id},isPrimary:true},{$set:{isPrimary:false}},{session});
  await Membership.findOneAndUpdate({student:student._id,institution:institution._id},{$set:{status:'active',isPrimary:true,leftAt:null,requestedAction:'',targetInstitution:null,reason:'Reactivated for institute inventory and health testing'},$setOnInsert:{program:profile.program||'',joinedAt:new Date()}},{upsert:true,session,runValidators:true});
 });
 const after=await Profile.findById(profile._id);const membership=await Membership.findOne({student:student._id,institution:institution._id});
 console.log(JSON.stringify({after:{profile:after.status,membership:membership.status},inventoryItems:await require('../models/InventoryItem').countDocuments({institution:institution._id})}));
}
run().catch(error=>{console.error('[SEED]',error.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
