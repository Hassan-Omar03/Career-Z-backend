// CZ-0012 (issue log V1): a new password may not match the current or the last three passwords.
const backend = (name) => require(name.startsWith('./') ? '../' + name.slice(2) : name);
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = backend('mongoose'), bcrypt = backend('bcryptjs'), jwt = backend('jsonwebtoken');
const { MongoMemoryReplSet } = backend('mongodb-memory-server');
process.env.NODE_ENV = 'test'; process.env.JWT_ACCESS_SECRET = 'password-history-regression';
const notifications = backend('./src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const app = backend('./src/app');
const model = name => backend('./src/models/' + name);
let mongo, server, base, user, auth;
const passwords = ['FirstPass@111', 'SecondPass@222', 'ThirdPass@333', 'FourthPass@444', 'FifthPass@555'];
async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type':'application/json', authorization:'Bearer ' + auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status:r.status, body:await r.json() };
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet:{count:1} }); await mongoose.connect(mongo.getUri());
  user = await model('User').create({ fullName:'Password Test', email:'password-history@test.local', passwordHash:await model('User').hashPassword(passwords[0]), emailVerified:true, roles:['student'], status:'active' });
  await model('RoleRequest').create({user:user._id,requestedRole:'student',status:'approved',approvedAt:new Date()});
  await model('UserProfile').updateOne({user:user._id,role:'student'},{$set:{completed:true,percent:100}},{upsert:true});
  auth = jwt.sign({sub:String(user._id)},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'});
  server = http.createServer(app).listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async()=>{if(server)await new Promise(r=>server.close(r));await mongoose.disconnect();if(mongo)await mongo.stop();});
test('CZ-0012: password change rejects current plus three previous passwords', async()=>{
  for(let i=1;i<4;i++){
    const changed=await call('PATCH','/users/me/password',{currentPassword:passwords[i-1],newPassword:passwords[i]});
    assert.equal(changed.status,200,JSON.stringify(changed.body));
  }
  const original=(await model('User').findById(user._id)).passwordHash;
  for(const password of passwords.slice(0,4)){
    const denied=await call('PATCH','/users/me/password',{currentPassword:passwords[3],newPassword:password});
    assert.equal(denied.status,422);assert.match(denied.body.message,/last 3 passwords/);
  }
  assert.equal((await model('User').findById(user._id)).passwordHash,original);
  const saved=await model('User').findById(user._id).select('+passwordHistory');
  assert.equal(saved.passwordHistory.length,3); assert(saved.passwordHistory.every(hash=>hash.startsWith('$2')));
});
test('CZ-0012: reset with a valid OTP also rejects old passwords and records a new password',async()=>{
  async function reset(newPassword){
    await model('VerificationCode').create({user:user._id,purpose:'password_reset',codeHash:await bcrypt.hash('123456',4),expiresAt:new Date(Date.now()+600000),consumed:false});
    return call('POST','/auth/reset-password',{email:user.email,code:'123456',newPassword});
  }
  for(const password of passwords.slice(0,4)){
    const r=await reset(password);assert.equal(r.status,422,JSON.stringify(r.body));
  }
  const changed=await reset(passwords[4]);assert.equal(changed.status,200,JSON.stringify(changed.body));
  const saved=await model('User').findById(user._id).select('+passwordHistory');
  assert(await saved.comparePassword(passwords[4]));assert.equal(saved.passwordHistory.length,3);
  assert(await bcrypt.compare(passwords[3],saved.passwordHistory[0]));
  const me=await call('GET','/auth/me');assert.equal(me.status,200);assert.equal(me.body.data.user.passwordHistory,undefined);assert.equal(saved.toSafeJSON().passwordHistory,undefined);
  assert.equal((await model('User').findById(user._id).lean()).passwordHistory,undefined);
});
test('CZ-0012: a password outside the retained three may be used again',async()=>{
  const r=await call('PATCH','/users/me/password',{currentPassword:passwords[4],newPassword:passwords[0]});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert(await (await model('User').findById(user._id)).comparePassword(passwords[0]));
});
