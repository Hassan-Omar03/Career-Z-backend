const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  provider: {type:String, required:true}, stateHash:{type:String,unique:true},
  bindingHash:String, verifier:String, nonce:String, redirectUri:String, returnOrigin:String,
  stage:{type:String,enum:['pending','processing','ready'],default:'pending'},
  ticketHash:{type:String,index:true}, profile:mongoose.Schema.Types.Mixed,
  expiresAt:{type:Date,required:true,index:{expires:0}}
},{timestamps:true});
module.exports=mongoose.model('SocialAuthFlow',schema);
