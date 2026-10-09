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

const ai=require('../src/services/ai.service');let calls=[];mock.method(ai,'generate',async(...args)=>{calls.push(args);return 'Verified summary';});mock.method(ai,'getAllInstitutionCredentialStatuses',async()=>({text:{configured:true}}));
const ctrl=require('../src/controllers/aiOperations.controller');
const Course=require('../src/models/Course'),Fee=require('../src/models/Fee'),Attendance=require('../src/models/Attendance'),StaffAttendance=require('../src/models/StaffAttendance'),Exam=require('../src/models/Exam'),ExamSubmission=require('../src/models/ExamSubmission'),Assignment=require('../src/models/Assignment'),Submission=require('../src/models/Submission'),Payslip=require('../src/models/Payslip');
const studentCtrl = require('../src/controllers/student.controller');
const parentCtrl = require('../src/controllers/parent.controller');
const employerCtrl = require('../src/controllers/institutionEmployer.controller');

let mongo, owner, staff, student, outsider, teacher, parent, institution;
const models = [
  User, Institution, StudentProfile, StudentInstitutionMembership, TeacherEmployment, ParentChildLink,
  HelpDeskTicket, InstitutionEvent, HealthIncident, InstitutionEmployerPartnership, PlacementReferral, Job,
  LibraryBook, LibraryLoan,Course,Fee,Attendance,StaffAttendance,Exam,ExamSubmission,Assignment,Submission,Payslip
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

beforeEach(async () => {calls=[];
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


test('institution metrics use paid/partial payments and separate currencies; excludes foreign records',async()=>{
 await Fee.create([{institution:institution._id,student:student._id,recordedBy:owner._id,title:'Paid',amount:100,currency:'PKR',status:'paid'},{institution:institution._id,student:student._id,recordedBy:owner._id,title:'Partial',amount:200,paidAmount:50,outstandingAmount:150,currency:'PKR',status:'partially_paid',dueDate:new Date('2020-01-01')},{institution:institution._id,student:student._id,recordedBy:owner._id,title:'USD',amount:10,currency:'USD',status:'pending'},{institution:outsider._id,student:student._id,recordedBy:owner._id,title:'Foreign',amount:999,currency:'PKR',status:'paid'}]);
 const r=await invoke(ctrl.insights,{user:owner,params:{id:institution._id}});assert.equal(r.status,200);assert.deepEqual(r.body.data.metrics.feesByCurrency.PKR,{collected:150,pending:0,overdue:150,scheduled:0});assert.equal(r.body.data.metrics.feesByCurrency.USD.pending,10);assert.equal(r.body.data.metrics.studentAttendance.attendancePercent,null);assert.equal(String(calls[0][3]),String(institution._id));
});
test('actual graded results and recorded attendance; missing grades not zero',async()=>{
 const c=await Course.create({institution:institution._id,teacher:teacher._id,title:'Computing'});const e=await Exam.create({course:c._id,teacher:teacher._id,title:'Test',questions:[{text:'Question',marks:20}]});await ExamSubmission.create({exam:e._id,student:student._id,status:'graded',score:15});const a=await Assignment.create({course:c._id,teacher:teacher._id,title:'Homework',maxMarks:10});await Submission.create({assignment:a._id,student:student._id,status:'graded',marksObtained:5});await Attendance.create({institution:institution._id,course:c._id,date:new Date(),markedBy:teacher._id,records:[{student:student._id,status:'present'},{student:outsider._id,status:'absent'},{student:parent._id,status:'excused'}]});
 const r=await ctrl.summary(institution);assert.equal(r.studentPerformanceByCourse[0].averagePercent,62.5);assert.equal(r.studentPerformanceByCourse[0].gradedResults,2);assert.equal(r.studentAttendance.attendancePercent,50);assert.equal(r.studentAttendance.excused,1);
});
test('ordinary staff/student cannot access institution financial insights',async()=>{
 for(const u of [outsider,student,teacher])assert.equal((await invoke(ctrl.insights,{user:u,params:{id:institution._id}})).status,403);assert.equal(calls.length,0);
});
test('teacher insights contain own courses only and no financial data',async()=>{
 await Course.create([{institution:institution._id,teacher:teacher._id,title:'My class'},{institution:institution._id,teacher:outsider._id,title:'Other teachers class'}]);const r=await invoke(ctrl.teachingInsights,{user:teacher});assert.equal(r.status,200);assert.match(r.body.data.dataSummary,/My class/);assert.doesNotMatch(r.body.data.dataSummary,/Other teachers class|feesByCurrency/);assert.equal((await invoke(ctrl.teachingInsights,{user:student})).status,404);
});
