const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

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

const ctrl = require('../src/controllers/eventsHelpdesk.controller');
const studentCtrl = require('../src/controllers/student.controller');
const parentCtrl = require('../src/controllers/parent.controller');
const employerCtrl = require('../src/controllers/institutionEmployer.controller');

let mongo, owner, staff, student, outsider, teacher, parent, institution;
const models = [
  User, Institution, StudentProfile, StudentInstitutionMembership, TeacherEmployment, ParentChildLink,
  HelpDeskTicket, InstitutionEvent, HealthIncident, InstitutionEmployerPartnership, PlacementReferral, Job,
  LibraryBook, LibraryLoan
];

before(async () => {
  mongo = await MongoMemoryServer.create();
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


test('student teacher parent relationships, audience filtering and safe public projection',async()=>{
 await TeacherEmployment.create({institution:institution._id,teacher:teacher._id,offeredBy:owner._id,status:'active',role:'teacher'});
 await ParentChildLink.create({parent:parent._id,student:student._id,status:'approved',requestedBy:parent._id});
 const e=await InstitutionEvent.create({institution:institution._id,title:'Teachers meeting',audience:['teachers'],startDate:new Date(),createdBy:owner._id});
 for(const u of [student,teacher,parent]){const r=await invoke(ctrl.institutions,{user:u});assert.equal(r.body.data.length,1);}
 assert.equal((await invoke(ctrl.listEvents,{user:teacher,params:{id:institution._id}})).body.data.length,1);
 assert.equal((await invoke(ctrl.listEvents,{user:parent,params:{id:institution._id}})).body.data.length,0);
 assert.equal((await invoke(ctrl.rsvp,{user:student,params:{eventId:e._id}})).status,403);
 const pub=await InstitutionEvent.create({institution:institution._id,title:'Open',startDate:new Date(),createdBy:owner._id,rsvps:[{user:teacher._id}]});
 const r=await invoke(ctrl.publicEvents,{params:{id:institution._id}});assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].rsvps,undefined);
 assert.equal((await invoke(ctrl.listEvents,{user:outsider,params:{id:institution._id}})).status,403);
});
test('event edits dates statuses and concurrent duplicate RSVP',async()=>{
 const r=await invoke(ctrl.createEvent,{user:owner,params:{id:institution._id},body:{title:'Sports',type:'sports_day',startDate:'2026-10-10T10:00:00Z',endDate:'2026-10-09T10:00:00Z'}});assert.equal(r.status,422);
 const e=await InstitutionEvent.create({institution:institution._id,title:'Sports',startDate:new Date(),createdBy:owner._id});
 const rs=await Promise.all([invoke(ctrl.rsvp,{user:student,params:{eventId:e._id}}),invoke(ctrl.rsvp,{user:student,params:{eventId:e._id}})]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
 assert.equal((await invoke(ctrl.updateEvent,{user:outsider,params:{eventId:e._id},body:{status:'completed'}})).status,403);
 assert.equal((await invoke(ctrl.updateEvent,{user:owner,params:{eventId:e._id},body:{status:'completed',venue:'Hall'}})).status,200);
 assert.equal((await invoke(ctrl.rsvp,{user:staff,params:{eventId:e._id}})).status,409);
 assert.equal((await invoke(ctrl.deleteEvent,{user:owner,params:{eventId:e._id}})).status,409);
 assert.equal((await invoke(ctrl.cancelRsvp,{user:student,params:{eventId:e._id}})).status,200);
});
test('ticket assignment teacher queue resolution transitions privacy and history',async()=>{
 await TeacherEmployment.create({institution:institution._id,teacher:teacher._id,offeredBy:owner._id,status:'active',role:'teacher'});
 const r=await invoke(ctrl.createTicket,{user:student,params:{id:institution._id},body:{category:'academic',subject:'Need help',description:'Full detail'}});assert.equal(r.status,201);const id=r.body.data._id;
 assert.equal((await invoke(ctrl.updateTicket,{user:owner,params:{ticketId:id},body:{assignedTo:outsider._id}})).status,422);
 assert.equal((await invoke(ctrl.updateTicket,{user:owner,params:{ticketId:id},body:{assignedTo:teacher._id}})).status,200);
 const queue=await invoke(ctrl.tickets,{user:teacher,params:{id:institution._id}});assert.equal(queue.body.data.length,1);assert.equal(queue.body.data[0].canUpdate,true);assert.equal(queue.body.data[0].description,'Full detail');
 assert.equal((await invoke(ctrl.tickets,{user:outsider,params:{id:institution._id}})).status,403);
 assert.equal((await invoke(ctrl.updateTicket,{user:student,params:{ticketId:id},body:{status:'resolved',resolutionNotes:'fake'}})).status,403);
 assert.equal((await invoke(ctrl.updateTicket,{user:teacher,params:{ticketId:id},body:{priority:'urgent'}})).status,403);
 assert.equal((await invoke(ctrl.updateTicket,{user:teacher,params:{ticketId:id},body:{status:'resolved'}})).status,422);
 assert.equal((await invoke(ctrl.updateTicket,{user:teacher,params:{ticketId:id},body:{status:'closed',resolutionNotes:'Skip'}})).status,409);
 assert.equal((await invoke(ctrl.updateTicket,{user:teacher,params:{ticketId:id},body:{status:'in_progress'}})).status,200);
 assert.equal((await invoke(ctrl.updateTicket,{user:teacher,params:{ticketId:id},body:{status:'resolved',resolutionNotes:'Fixed'}})).status,200);
 assert.equal((await invoke(ctrl.updateTicket,{user:owner,params:{ticketId:id},body:{status:'closed'}})).status,200);
 const t=await HelpDeskTicket.findById(id);assert.equal(t.status,'closed');assert.equal(t.history.length,5);
 assert.equal((await invoke(ctrl.updateTicket,{user:owner,params:{ticketId:id},body:{status:'open'}})).status,409);
});
