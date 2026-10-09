const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentProfile = require('../src/models/StudentProfile');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const TeacherEmployment = require('../src/models/TeacherEmployment');
const ParentChildLink = require('../src/models/ParentChildLink');
const HelpDeskTicket = require('../src/models/HelpDeskTicket');
const InstitutionEvent = require('../src/models/InstitutionEvent');
const HealthIncident = require('../src/models/HealthIncident');
const InstitutionEmployerPartnership = require('../src/models/InstitutionEmployerPartnership');
const PlacementReferral = require('../src/models/PlacementReferral');
const Job = require('../src/models/Job');
const LibraryBook = require('../src/models/LibraryBook');
const LibraryLoan = require('../src/models/LibraryLoan');

const ctrl=require('../src/controllers/placement.controller');const Application=require('../src/models/JobApplication'),Resume=require('../src/models/Resume');
const studentCtrl = require('../src/controllers/student.controller');
const parentCtrl = require('../src/controllers/parent.controller');
const employerCtrl = require('../src/controllers/institutionEmployer.controller');

let mongo, owner, staff, student, outsider, teacher, parent, institution;
const models = [
  User, Institution, StudentProfile, StudentInstitutionMembership, TeacherEmployment, ParentChildLink,
  HelpDeskTicket, InstitutionEvent, HealthIncident, InstitutionEmployerPartnership, PlacementReferral, Job,
  LibraryBook, LibraryLoan, Application, Resume
];

before(async () => {
  mongo = await MongoMemoryReplSet.create({replSet:{count:1}});
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  owner = await User.create({ fullName: 'Ops Owner', email: 'ops2-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  staff = await User.create({ fullName: 'Ops Staff', email: 'ops2-staff@test.local', passwordHash: 'x', roles: ['institution_staff'] });
  student = await User.create({ fullName: 'Ops Student', email: 'ops2-student@test.local', passwordHash: 'x', roles: ['student'] });
  outsider = await User.create({ fullName: 'Outsider', email: 'ops2-outsider@test.local', passwordHash: 'x', roles: ['student'] });
  teacher = await User.create({ fullName: 'Ops Teacher', email: 'ops2-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  parent = await User.create({ fullName: 'Ops Parent', email: 'ops2-parent@test.local', passwordHash: 'x', roles: ['parent'] });
  institution = await Institution.create({
    name: 'Ops Institution 2', slug: 'ops-institution-2', type: 'school', country: 'PK', owner: owner._id,
    verificationStatus: 'approved', staff: [{ user: staff._id, role: 'other', permissions: ['institution:ops:manage'] }]
  });
  await StudentInstitutionMembership.create({ student: student._id, institution: institution._id, status: 'active' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
});


async function setup(){outsider.roles=['employer'];await outsider.save();const job=await Job.create({postedBy:outsider._id,title:'Intern',company:'Demo',country:'PK',status:'active'});return job;}
test('both partnership request directions require other-party approval and support ending',async()=>{
 await setup();let r=await invoke(ctrl.requestPartnership,{user:outsider,body:{institutionId:institution._id,employerEmail:outsider.email}});assert.equal(r.status,201);const id=r.body.data._id;
 assert.equal((await invoke(ctrl.respondPartnership,{user:outsider,params:{id},body:{decision:'active'}})).status,403);
 let list=await invoke(ctrl.myPartnerships,{user:owner});assert.equal(list.body.data[0].canRespond,true);
 assert.equal((await invoke(ctrl.respondPartnership,{user:owner,params:{id},body:{decision:'active'}})).status,200);
 assert.equal((await invoke(ctrl.endPartnership,{user:owner,params:{id}})).status,200);
 r=await invoke(ctrl.requestPartnership,{user:owner,body:{institutionId:institution._id,employerEmail:outsider.email}});assert.equal(r.status,201);
 assert.equal((await invoke(ctrl.respondPartnership,{user:owner,params:{id:r.body.data._id},body:{decision:'active'}})).status,403);
 assert.equal((await invoke(ctrl.respondPartnership,{user:outsider,params:{id:r.body.data._id},body:{decision:'active'}})).status,200);
});
test('student referral apply has real application status and accurate statistics',async()=>{
 const job=await setup();await InstitutionEmployerPartnership.create({institution:institution._id,employer:outsider._id,requestedBy:owner._id,status:'active'});
 const r=await invoke(ctrl.createReferral,{user:owner,body:{institutionId:institution._id,studentId:student._id,jobId:job._id}});assert.equal(r.status,201);const id=r.body.data._id;
 assert.equal((await invoke(ctrl.applyViaReferral,{user:teacher,params:{id}})).status,403);
 const applied=await invoke(ctrl.applyViaReferral,{user:student,params:{id}});assert.equal(applied.status,200);assert.equal(await Application.countDocuments(),1);
 await Application.updateOne({_id:applied.body.data.application},{$set:{status:'hired'}});
 const mine=await invoke(ctrl.myReferrals,{user:student});assert.equal(mine.body.data[0].status,'hired');assert.equal(mine.body.data[0].applicationStatus,'hired');
 const stats=await invoke(ctrl.institutionReferrals,{user:owner,params:{id:institution._id}});assert.equal(stats.body.data.stats.applied,1);assert.equal(stats.body.data.stats.placed,1);
 assert.equal((await invoke(ctrl.applyViaReferral,{user:student,params:{id}})).status,409);
});
test('membership scope closed jobs deadlines partnership and decline checks',async()=>{
 const job=await setup();await InstitutionEmployerPartnership.create({institution:institution._id,employer:outsider._id,requestedBy:owner._id,status:'active'});const body={institutionId:institution._id,studentId:student._id,jobId:job._id};
 await StudentInstitutionMembership.updateOne({student:student._id},{$set:{status:'withdrawn'}});assert.equal((await invoke(ctrl.createReferral,{user:owner,body})).status,422);
 await StudentInstitutionMembership.updateOne({student:student._id},{$set:{status:'graduated'}});await Job.updateOne({_id:job._id},{$set:{status:'closed'}});assert.equal((await invoke(ctrl.createReferral,{user:owner,body})).status,409);await Job.updateOne({_id:job._id},{$set:{status:'active'}});
 const r=await invoke(ctrl.createReferral,{user:owner,body});assert.equal(r.status,201);await InstitutionEmployerPartnership.updateMany({},{$set:{status:'ended'}});assert.equal((await invoke(ctrl.applyViaReferral,{user:student,params:{id:r.body.data._id}})).status,409);
 assert.equal((await invoke(ctrl.declineReferral,{user:student,params:{id:r.body.data._id}})).status,200);const stats=await invoke(ctrl.institutionReferrals,{user:owner,params:{id:institution._id}});assert.equal(stats.body.data.stats.applied,0);assert.equal(stats.body.data.stats.declined,1);
});
test('teacher requires explicit permission; owner can grant and revoke',async()=>{
 institution.staff.push({user:teacher._id,role:'teacher',permissions:[]});await institution.save();assert.equal((await invoke(ctrl.institutions,{user:teacher})).body.data.length,0);
 assert.equal((await invoke(ctrl.permission,{user:teacher,params:{id:institution._id,userId:teacher._id},body:{enabled:true}})).status,403);
 assert.equal((await invoke(ctrl.permission,{user:owner,params:{id:institution._id,userId:teacher._id},body:{enabled:true}})).status,200);
 assert.equal((await invoke(ctrl.institutions,{user:teacher})).body.data.length,1);
 assert.equal((await invoke(ctrl.institutionReferrals,{user:teacher,params:{id:institution._id}})).status,200);
 assert.equal((await invoke(ctrl.permission,{user:owner,params:{id:institution._id,userId:teacher._id},body:{enabled:false}})).status,200);
 assert.equal((await invoke(ctrl.institutionReferrals,{user:teacher,params:{id:institution._id}})).status,403);
});

test('selected secondary institution and catalogue are correctly scoped; concurrent apply stays unique',async()=>{
 const job=await setup();const second=await Institution.create({name:'Second',slug:'second-placement',type:'school',country:'PK',owner:owner._id});await StudentInstitutionMembership.create({student:student._id,institution:second._id,status:'active'});await InstitutionEmployerPartnership.create({institution:second._id,employer:outsider._id,requestedBy:owner._id,status:'active'});
 const catalogue=await invoke(ctrl.catalogue,{user:owner,params:{id:second._id}});assert.equal(catalogue.body.data.jobs.length,1);assert.equal(catalogue.body.data.students.length,1);const primary=await invoke(ctrl.catalogue,{user:owner,params:{id:institution._id}});assert.equal(primary.body.data.jobs.length,0);
 await Job.updateOne({_id:job._id},{$set:{applicationDeadline:new Date('2020-01-01')}});assert.equal((await invoke(ctrl.createReferral,{user:owner,body:{institutionId:second._id,studentId:student._id,jobId:job._id}})).status,409);await Job.updateOne({_id:job._id},{$set:{applicationDeadline:null}});
 const r=await invoke(ctrl.createReferral,{user:owner,body:{institutionId:second._id,studentId:student._id,jobId:job._id}});assert.equal(r.status,201);assert.equal(String(r.body.data.institution),String(second._id));
 const rs=await Promise.all([invoke(ctrl.applyViaReferral,{user:student,params:{id:r.body.data._id}}),invoke(ctrl.applyViaReferral,{user:student,params:{id:r.body.data._id}})]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);assert.equal(await Application.countDocuments(),1);
});
