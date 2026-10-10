const mongoose=require('mongoose');
const schema=new mongoose.Schema({provider:{type:String,required:true},subject:{type:String,required:true},user:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true}},{timestamps:true});
schema.index({provider:1,subject:1},{unique:true});
module.exports=mongoose.model('SocialIdentity',schema);
