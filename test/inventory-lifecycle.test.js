const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV='test';
mock.method(require('../src/services/notification.service'),'notify',async()=>{});
const User=require('../src/models/User');
const Institution=require('../src/models/Institution');
const Membership=require('../src/models/StudentInstitutionMembership');
const Employment=require('../src/models/TeacherEmployment');
const Item=require('../src/models/InventoryItem');
const Loan=require('../src/models/InventoryLoan');
const ctrl=require('../src/controllers/inventory.controller');
let db,owner,student,teacher,outsider,inst,item;
before(async()=>{db=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(db.getUri());await Promise.all([User,Institution,Membership,Employment,Item,Loan].map(m=>m.init()));});
after(async()=>{await mongoose.disconnect();await db.stop();});
beforeEach(async()=>{
 await Promise.all([User,Institution,Membership,Employment,Item,Loan].map(m=>m.deleteMany({})));
 [owner,student,teacher,outsider]=await User.create(['Owner','Student','Teacher','Outsider'].map((name,i)=>({fullName:name,email:'inventory'+i+'@test.test',passwordHash:'unused'})));
 inst=await Institution.create({owner:owner._id,name:'School',slug:'inventory-school',type:'school',country:'PK'});
 await Membership.create({institution:inst._id,student:student._id,status:'active'});
 await Employment.create({institution:inst._id,teacher:teacher._id,status:'active',offeredBy:owner._id});
 item=await Item.create({institution:inst._id,name:'Laptop',category:'computer',quantity:2,addedBy:owner._id});
});
function invoke(fn,user=owner,params={},body={}){return new Promise((resolve,reject)=>{let status=200;const res={status(v){status=v;return this;},json(value){resolve({status,...value});return this;}};fn({user,params,body},res,reject);});}
const issue=(recipient=student,quantity=1)=>invoke(ctrl.issue,owner,{itemId:item.id},{recipient:recipient.id,quantity});
const action=(loan,a,user=owner,extra={})=>invoke(ctrl.action,user,{loanId:loan._id},{action:a,...extra});
test('student request, manager approval, return request and receipt keep stock accurate and history intact',async()=>{
 const loan=(await invoke(ctrl.request,student,{itemId:item.id},{quantity:1,reason:'Study'})).data;
 assert.equal((await Item.findById(item.id)).allocatedQuantity,0);
 await action(loan,'approve');assert.equal((await Item.findById(item.id)).allocatedQuantity,1);
 await action(loan,'return',student);assert.equal((await Item.findById(item.id)).allocatedQuantity,1);
 await action(loan,'receive',owner,{condition:'good'});assert.equal((await Item.findById(item.id)).allocatedQuantity,0);
 assert.equal((await Loan.findById(loan._id)).history.length,4);
 await assert.rejects(action(loan,'receive',owner,{condition:'good'}),{statusCode:409});
});
test('teacher damage report and damaged return quarantine stock until repaired',async()=>{
 const loan=(await issue(teacher,2)).data;
 await action(loan,'damage',teacher,{notes:'Screen broken'});
 await action(loan,'receive',owner,{condition:'damaged'});
 assert.equal((await Item.findById(item.id)).damagedQuantity,2);
 await assert.rejects(issue(),{statusCode:409});
 await invoke(ctrl.update,owner,{itemId:item.id},{damagedQuantity:0});
 await issue();assert.equal((await Item.findById(item.id)).allocatedQuantity,1);
});
test('concurrent issues cannot overallocate stock',async()=>{
 const results=await Promise.allSettled([issue(student,2),issue(teacher,2)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await Item.findById(item.id)).allocatedQuantity,2);
 assert.equal(await Loan.countDocuments({status:'issued'}),1);
});
test('tenant isolation, ownership and active membership checks reject unrelated users',async()=>{
 await assert.rejects(issue(outsider),{statusCode:403});
 await assert.rejects(invoke(ctrl.request,outsider,{itemId:item.id},{quantity:1}),{statusCode:403});
 await assert.rejects(invoke(ctrl.list,student,{id:inst.id}),{statusCode:403});
 const loan=(await issue()).data;
 await assert.rejects(action(loan,'return',teacher),{statusCode:403});
 assert.equal((await invoke(ctrl.mine,outsider)).data.items.length,0);
 assert.equal((await invoke(ctrl.mine,teacher)).data.items.length,1);
 assert.equal((await invoke(ctrl.mine,teacher)).data.loans.length,0);
});
test('pending cancellation and rejection never reduce stock; inactive requester cannot be approved',async()=>{
 const loan=(await invoke(ctrl.request,student,{itemId:item.id},{quantity:1})).data;
 await action(loan,'cancel',student);assert.equal((await Item.findById(item.id)).allocatedQuantity,0);
 const another=(await invoke(ctrl.request,teacher,{itemId:item.id},{quantity:1})).data;
 await action(another,'reject');assert.equal((await Item.findById(item.id)).allocatedQuantity,0);
 const last=(await invoke(ctrl.request,student,{itemId:item.id},{quantity:1})).data;
 await Membership.updateOne({student:student._id},{status:'withdrawn'});
 await assert.rejects(action(last,'approve'),{statusCode:403});
});
test('stock edits validate integers, costs and issued quantities; historical items cannot be deleted',async()=>{
 await assert.rejects(issue(student,1.5),{statusCode:422});
 await assert.rejects(invoke(ctrl.update,owner,{itemId:item.id},{purchaseCost:-1}));
 await issue(student,2);
 await assert.rejects(invoke(ctrl.update,owner,{itemId:item.id},{quantity:1}),{statusCode:422});
 await assert.rejects(invoke(ctrl.remove,owner,{itemId:item.id}),{statusCode:409});
 await assert.rejects(invoke(ctrl.update,owner,{itemId:item.id},{assignedTo:outsider.id}),{statusCode:422});
});
test('stationery creation, editing and clean deletion work for managers',async()=>{
 const asset=(await invoke(ctrl.create,owner,{id:inst.id},{name:'Pens',category:'stationery',quantity:10,purchaseCost:2})).data;
 await invoke(ctrl.update,owner,{itemId:asset.id || asset._id},{condition:'needs_repair',notes:'Repair',location:'Lab',purchaseDate:'2026-10-01'});
 assert.equal((await Item.findById(asset._id)).notes,'Repair');
 await invoke(ctrl.remove,owner,{itemId:asset._id});assert.equal(await Item.findById(asset._id),null);
});

test('legacy active primary-institution students can view and request inventory without overriding a withdrawn membership',async()=>{
 const Profile=require('../src/models/StudentProfile');
 await Membership.deleteOne({student:student._id});
 await Profile.create({user:student._id,primaryInstitution:inst._id,status:'active'});
 const data=(await invoke(ctrl.mine,student)).data;
 assert.equal(data.institutions.length,1);assert.equal(data.items.length,1);
 await invoke(ctrl.request,student,{itemId:item.id},{quantity:1});
 await Membership.create({student:student._id,institution:inst._id,status:'withdrawn'});
 assert.equal((await invoke(ctrl.mine,student)).data.items.length,0);
 await assert.rejects(invoke(ctrl.request,student,{itemId:item.id},{quantity:1}),{statusCode:403});
 await Profile.deleteMany({});
});
