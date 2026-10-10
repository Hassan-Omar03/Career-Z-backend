const {test,before,after,beforeEach,mock}=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {MongoMemoryServer}=require('mongodb-memory-server');
process.env.NODE_ENV='test';
const service=require('../src/services/socialAuth.service');
const ctrl=require('../src/controllers/socialAuth.controller');
const Flow=require('../src/models/SocialAuthFlow');const Identity=require('../src/models/SocialIdentity');
const User=require('../src/models/User');const Role=require('../src/models/RoleRequest');const History=require('../src/models/VerificationHistory');const Blocked=require('../src/models/BlockedIp');
const otp=require('../src/services/otp.service');const tokens=require('../src/services/token.service');
const challenges=[];mock.method(otp,'issueOtp',async(user,purpose)=>{challenges.push(purpose);});
mock.method(tokens,'issueTokenPair',async()=>({accessToken:'test-access',refreshToken:'test-refresh'}));
let database;
before(async()=>{database=await MongoMemoryServer.create();await mongoose.connect(database.getUri());await Promise.all([Flow,Identity,User,Role,History,Blocked].map(m=>m.init()));});
after(async()=>{await mongoose.disconnect();await database.stop();});
beforeEach(async()=>{challenges.length=0;await Promise.all([Flow,Identity,User,Role,History,Blocked].map(m=>m.deleteMany({})));});
function run(handler,req){return new Promise((resolve,reject)=>{const res={set(){return this;},status(){return this;},json(value){resolve(value);},redirect(status,url){resolve({status,url});}};handler({headers:{},ip:'127.0.0.1',...req},res,reject);});}
async function ready(extra={}){const ticket=service.random(),verifier=service.random();const flow=await Flow.create({provider:'google',stateHash:service.hash(service.random()),bindingHash:service.hash(verifier),ticketHash:service.hash(ticket),stage:'ready',profile:{subject:'provider-user-1',email:'sample@example.test',name:'Sample User'},returnOrigin:'http://localhost:5173',expiresAt:new Date(Date.now()+60000),...extra});return {flow,body:{ticket,verifier}};}
async function existing(extra={}){return User.create({fullName:'Existing User',email:'sample@example.test',passwordHash:'test',roles:['teacher'],...extra});}
test('unknown provider and unconfigured sign-in fail clearly',async()=>{assert.throws(()=>service.settings('evil'),/Unsupported/);const old=process.env.GOOGLE_CLIENT_ID;delete process.env.GOOGLE_CLIENT_ID;try{await assert.rejects(service.authorization('google',service.settings('google'),{}),/not configured/);}finally{if(old)process.env.GOOGLE_CLIENT_ID=old;}});
test('start rejects an untrusted return URL',async()=>{await assert.rejects(run(ctrl.start,{params:{provider:'google'},body:{returnOrigin:'https://evil.test',bindingHash:'a'.repeat(64)}}),/return address/);});
test('wrong browser verifier cannot consume a handoff',async()=>{const {flow,body}=await ready();await assert.rejects(run(ctrl.exchange,{body:{...body,verifier:service.random()}}),/expired/);assert(await Flow.exists({_id:flow._id}));});
test('expired handoff cannot authenticate',async()=>{const {body}=await ready({expiresAt:new Date(Date.now()-1000)});await assert.rejects(run(ctrl.exchange,{body}),/expired/);});
test('new social user remains a student awaiting verification',async()=>{const {body}=await ready();const result=await run(ctrl.exchange,{body});assert.equal(result.data.user.emailVerified,false);assert.deepEqual(result.data.user.roles,['student']);assert.equal(await Role.countDocuments({status:'awaiting_documents'}),1);assert.equal(await Identity.countDocuments(),1);assert.deepEqual(challenges,['email_verify']);assert.equal(result.data.accessToken,'test-access');await assert.rejects(run(ctrl.exchange,{body}),/expired/);});
test('matching email is not automatically linked or logged in',async()=>{const user=await existing();const {flow,body}=await ready();const result=await run(ctrl.exchange,{body});assert.equal(result.data.linkRequired,true);assert.equal(result.data.accessToken,undefined);assert.equal(await Identity.countDocuments(),0);assert(await Flow.exists({_id:flow._id}));assert.deepEqual(user.roles,['teacher']);});
test('authenticated matching account can link once',async()=>{const user=await existing();const {body}=await ready();await run(ctrl.link,{body,user});assert.equal(String((await Identity.findOne()).user),String(user._id));await assert.rejects(run(ctrl.link,{body,user}),/expired/);});
test('linking a different email is rejected',async()=>{const user=await existing({email:'other@example.test'});const {body}=await ready();await assert.rejects(run(ctrl.link,{body,user}),/different email/);assert.equal(await Identity.countDocuments(),0);});
test('linked login enforces two-factor authentication',async()=>{const user=await existing({twoFactorEnabled:true});await Identity.create({provider:'google',subject:'provider-user-1',user:user._id});const {body}=await ready();const result=await run(ctrl.exchange,{body});assert.equal(result.data.twoFactorRequired,true);assert.equal(result.data.accessToken,undefined);assert.deepEqual(challenges,['login_2fa']);});
test('suspended linked accounts cannot log in',async()=>{const user=await existing({status:'suspended'});await Identity.create({provider:'google',subject:'provider-user-1',user:user._id});const {body}=await ready();await assert.rejects(run(ctrl.exchange,{body}),/not active/);});
test('blocked IP cannot exchange a social login',async()=>{await Blocked.create({ip:'127.0.0.1',blockedBy:new mongoose.Types.ObjectId()});const {body}=await ready();await assert.rejects(run(ctrl.exchange,{body}),/blocked/);});
test('provider denial returns a safe frontend error and invalidates state',async()=>{const state=service.random();await Flow.create({provider:'google',stateHash:service.hash(state),stage:'pending',returnOrigin:'http://localhost:5173',expiresAt:new Date(Date.now()+60000)});const result=await run(ctrl.callback,{method:'GET',params:{provider:'google'},query:{state,error:'access_denied'}});assert.equal(result.status,303);assert.match(result.url,/social-callback\?error=/);assert.equal(await Flow.countDocuments(),0);});
