const service=require('../services/socialAuth.service');
const Flow=require('../models/SocialAuthFlow');
const Identity=require('../models/SocialIdentity');
const User=require('../models/User');
const RoleRequest=require('../models/RoleRequest');
const History=require('../models/VerificationHistory');
const BlockedIp=require('../models/BlockedIp');
const otp=require('../services/otp.service');
const tokens=require('../services/token.service');
const verification=require('../config/accountVerification');
const {isAllowedOrigin}=require('../utils/allowedOrigins');
const {ok}=require('../utils/apiResponse');
const AppError=require('../utils/AppError');
const asyncHandler=require('../utils/asyncHandler');
const providers=asyncHandler(async(req,res)=>ok(res,service.availability()));
const start=asyncHandler(async(req,res)=>{
 const provider=req.params.provider, config=service.settings(provider);
 const returnOrigin=req.body.returnOrigin;
 if(!isAllowedOrigin(returnOrigin))throw new AppError('Invalid sign-in return address.',400);
 if(!/^[a-f0-9]{64}$/.test(req.body.bindingHash||''))throw new AppError('Invalid browser sign-in verification.',400);
 const state=service.random(), verifier=service.random(), nonce=service.random();
 const url=await service.authorization(provider,config,{state,verifier,nonce});
 await Flow.create({provider,stateHash:service.hash(state),bindingHash:req.body.bindingHash,verifier,nonce,redirectUri:config.redirectUri,returnOrigin,expiresAt:new Date(Date.now()+10*60000)});
 res.set('Cache-Control','no-store');return ok(res,{url});
});
const callback=asyncHandler(async(req,res)=>{
 const params=req.method==='POST'?req.body:req.query;
 const flow=await Flow.findOneAndUpdate({provider:req.params.provider,stateHash:service.hash(params.state||''),stage:'pending',expiresAt:{$gt:new Date()}},{$set:{stage:'processing'}},{new:true});
 if(!flow)throw new AppError('Sign-in expired or was already used. Please start again.',400);
 res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
 try{
  if(params.error)throw new Error('Provider cancelled');
  const profile=await service.resolveProfile(flow.provider,service.settings(flow.provider),flow,req);
  if(!profile.subject)throw new Error('Missing identity');
  const ticket=service.random();flow.profile=profile;flow.ticketHash=service.hash(ticket);flow.stage='ready';flow.expiresAt=new Date(Date.now()+5*60000);flow.verifier=undefined;flow.nonce=undefined;await flow.save();
  return res.redirect(303,flow.returnOrigin+'/social-callback?ticket='+encodeURIComponent(ticket));
 }catch(err){
  // Log why (provider error code or exchange failure) — never tokens or secrets.
  console.error('[social-auth] '+flow.provider+' sign-in failed:',params.error?(params.error+(params.error_description?' - '+params.error_description:'')):(err?.error||err?.code||''),err?.error_description||err?.message||'');
  await Flow.deleteOne({_id:flow._id});return res.redirect(303,flow.returnOrigin+'/social-callback?error=cancelled_or_failed');}
});
async function getFlow(body){if(!/^[A-Za-z0-9_-]{43}$/.test(body.ticket||'')||!/^[A-Za-z0-9_-]{43}$/.test(body.verifier||''))throw new AppError('Sign-in session is missing. Please start again.',400);
 const flow=await Flow.findOne({ticketHash:service.hash(body.ticket),bindingHash:service.hash(body.verifier),stage:'ready',expiresAt:{$gt:new Date()}});
 if(!flow)throw new AppError('Sign-in expired or was already used. Please start again.',400);return flow;
}
async function consume(flow){const claimed=await Flow.findOneAndDelete({_id:flow._id,stage:'ready',expiresAt:{$gt:new Date()}});if(!claimed)throw new AppError('Sign-in was already used.',400);}
const exchange=asyncHandler(async(req,res)=>{
 res.set('Cache-Control','no-store');
 if(await BlockedIp.findOne({ip:req.ip}))throw new AppError('This network address is blocked.',403);
 const flow=await getFlow(req.body);let identity=await Identity.findOne({provider:flow.provider,subject:flow.profile.subject});let user;
 if(identity)user=await User.findById(identity.user);
 else{
  const email=String(flow.profile.email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError('Your provider did not share an email. Use email/password to create or access your account.',422);
  if(await User.exists({email}))return ok(res,{linkRequired:true},'Sign in with your existing password to connect this provider securely.');
  await consume(flow);
  try{user=await User.create({email,fullName:String(flow.profile.name||email.split('@')[0]).slice(0,150),passwordHash:await User.hashPassword(service.random()),roles:['student']});}
  catch(error){if(error.code===11000)throw new AppError('An account now exists with this email. Sign in with your password and try again.',409);throw error;}
  const roleRequest=await RoleRequest.create({user:user._id,requestedRole:'student',subtype:verification.SUBTYPES.student?.[0]||'',status:'awaiting_documents'});
  await History.create({user:user._id,role:'student',request:roleRequest._id,previousStatus:'',newStatus:'awaiting_documents',remarks:'Registered through '+flow.provider+'.'});
  await Identity.create({provider:flow.provider,subject:flow.profile.subject,user:user._id});
  await otp.issueOtp(user,'email_verify');
 }
 if(!user||user.status!=='active')throw new AppError('This account is not active.',403);
 if(identity)await consume(flow);
 if(user.twoFactorEnabled){await otp.issueOtp(user,'login_2fa');return ok(res,{twoFactorRequired:true,email:user.email});}
 user.lastLoginAt=new Date();await user.save();
 return ok(res,{user:user.toSafeJSON(),permissions:user.permissions(),...await tokens.issueTokenPair(user,{ip:req.ip,deviceInfo:req.headers['user-agent']})});
});
const link=asyncHandler(async(req,res)=>{
 const flow=await getFlow(req.body);
 if(String(flow.profile.email||'').trim().toLowerCase()!==req.user.email)throw new AppError('This provider belongs to a different email. Sign in with the matching account.',409);
 if(req.user.status!=='active')throw new AppError('This account is not active.',403);
 const existing=await Identity.findOne({provider:flow.provider,subject:flow.profile.subject});
 if(existing&&String(existing.user)!==String(req.user._id))throw new AppError('Provider is linked to another account.',409);
 await consume(flow);if(!existing)await Identity.create({provider:flow.provider,subject:flow.profile.subject,user:req.user._id});
 return ok(res,null,'Provider connected.');
});
module.exports={providers,start,callback,exchange,link,getFlow};
