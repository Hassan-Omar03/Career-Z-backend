const AppError=require('../utils/AppError');
function normalize(input,user,{required=false}={}){
 const out={};
 if(required&&(!String(input.parentName||'').trim()||!['father','mother','guardian'].includes(input.parentRelationship)))throw new AppError('Parent / guardian name, email and relationship are required before saving your student profile.',422);
 if(required||input.parentEmail!==undefined){const email=String(input.parentEmail||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200)throw new AppError('Enter a valid parent / guardian email address.',422);if(email===String(user.email||'').trim().toLowerCase())throw new AppError('Parent email must be different from your student email.',422);out.parentEmail=email;}
 if(input.parentName!==undefined)out.parentName=String(input.parentName||'').trim().slice(0,150);
 if(input.parentRelationship!==undefined){if(!['father','mother','guardian'].includes(input.parentRelationship))throw new AppError('Choose father, mother or guardian.',422);out.parentRelationship=input.parentRelationship;}
 return out;
}
async function sync(user,fields){const update=normalize(fields,user);if(!Object.keys(update).length)return;await require('../models/StudentProfile').findOneAndUpdate({user:user._id},{$set:update},{upsert:true,new:true,runValidators:true});await require('../models/UserProfile').findOneAndUpdate({user:user._id,role:'student'},{$set:Object.fromEntries(Object.entries(update).map(([k,v])=>['fields.'+k,v]))},{upsert:true,runValidators:true});}
module.exports={normalize,sync};
