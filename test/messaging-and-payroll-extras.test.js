const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
const realtime = require('../src/realtime/socket');
mock.method(realtime, 'emitToUser', () => {});
mock.method(realtime, 'broadcastGroupMessage', () => {});
let onlineFlag = false;
mock.method(realtime, 'isUserOnline', () => onlineFlag);

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const CoursePurchase = require('../src/models/CoursePurchase');
const TeacherEmployment = require('../src/models/TeacherEmployment');
const Payslip = require('../src/models/Payslip');
const BlockedUser = require('../src/models/BlockedUser');
const GroupConversation = require('../src/models/GroupConversation');
const GroupMessage = require('../src/models/GroupMessage');
const messageCtrl = require('../src/controllers/message.controller');
const groupCtrl = require('../src/controllers/groupConversation.controller');
const institutionCtrl = require('../src/controllers/institution.controller');
const { canCommunicate } = require('../src/utils/messageAccess');

let mongo, teacher, studentA, studentB, outsider, institution, course;
const models = [User, Institution, Course, Enrollment, CoursePurchase, TeacherEmployment, Payslip, BlockedUser, GroupConversation, GroupMessage];

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
  teacher = await User.create({ fullName: 'Msg Teacher', email: 'msg-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  studentA = await User.create({ fullName: 'Msg Student A', email: 'msg-student-a@test.local', passwordHash: 'x', roles: ['student'] });
  studentB = await User.create({ fullName: 'Msg Student B', email: 'msg-student-b@test.local', passwordHash: 'x', roles: ['student'] });
  outsider = await User.create({ fullName: 'Outsider', email: 'msg-outsider@test.local', passwordHash: 'x', roles: ['student'] });
  institution = await Institution.create({ name: 'Msg Institution', slug: 'msg-institution', type: 'school', country: 'PK', owner: teacher._id, verificationStatus: 'approved' });
  course = await Course.create({ title: 'Msg Course', teacher: teacher._id, institution: institution._id, published: true, isFree: true });
  await Enrollment.create({ student: studentA._id, course: course._id, status: 'active' });
  await Enrollment.create({ student: studentB._id, course: course._id, status: 'active' });
});

test('a blocked contact can no longer message, even though they still share a course', async () => {
  const before1 = await canCommunicate(teacher._id, studentA._id);
  assert.equal(before1, true);

  await invoke(messageCtrl.blockUser, { user: teacher, params: { userId: studentA._id.toString() } });
  const blocked = await canCommunicate(teacher._id, studentA._id);
  assert.equal(blocked, false);
  const blockedReverse = await canCommunicate(studentA._id, teacher._id);
  assert.equal(blockedReverse, false, 'block is checked in both directions');

  const send = await invoke(messageCtrl.sendMessage, { user: studentA, body: { to: teacher._id.toString(), text: 'hi' } });
  assert.equal(send.status, 403);

  await invoke(messageCtrl.unblockUser, { user: teacher, params: { userId: studentA._id.toString() } });
  assert.equal(await canCommunicate(teacher._id, studentA._id), true);
});

test('a message reports deliveredAt only when the recipient is actually online', async () => {
  const sent = await invoke(messageCtrl.sendMessage, { user: teacher, body: { to: studentA._id.toString(), text: 'hi' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.deliveredAt, null);

  onlineFlag = true;
  const sent2 = await invoke(messageCtrl.sendMessage, { user: teacher, body: { to: studentA._id.toString(), text: 'hi again' } });
  assert.ok(sent2.body.data.deliveredAt, 'delivered immediately when the recipient has a live connection');
  onlineFlag = false;
});

test('a group can only be created from existing valid contacts, and only members can post/read', async () => {
  const badGroup = await invoke(groupCtrl.createGroup, { user: teacher, body: { name: 'Bad', memberIds: [outsider._id.toString()] } });
  assert.equal(badGroup.status, 422, 'outsider is not a valid contact, and there are not 2 valid members');

  const group = await invoke(groupCtrl.createGroup, { user: teacher, body: { name: 'Class Chat', memberIds: [studentA._id.toString(), studentB._id.toString(), outsider._id.toString()] } });
  assert.equal(group.status, 201);
  assert.equal(group.body.data.participants.length, 3, 'outsider silently excluded, teacher+A+B remain');

  const groupId = group.body.data._id;
  const posted = await invoke(groupCtrl.sendMessage, { user: studentA, params: { id: groupId }, body: { text: 'hello group' } });
  assert.equal(posted.status, 201);

  const blocked = await invoke(groupCtrl.sendMessage, { user: outsider, params: { id: groupId }, body: { text: 'sneaking in' } });
  assert.equal(blocked.status, 403);

  const messages = await invoke(groupCtrl.listMessages, { user: studentB, params: { id: groupId } });
  assert.equal(messages.status, 200);
  assert.equal(messages.body.data.length, 1);
});

test('commission payroll is computed from real paid course-purchase revenue, not self-reported', async () => {
  await TeacherEmployment.create({ institution: institution._id, teacher: teacher._id, offeredBy: teacher._id, status: 'active', salaryType: 'commission', commissionPercent: 10, salaryCurrency: 'USD' });
  const now = new Date();
  await CoursePurchase.create({ course: course._id, student: studentA._id, provider: 'stripe', providerCheckoutId: 'cs_1', amountMinor: 10000, currency: 'USD', status: 'paid', paidAt: now });
  await CoursePurchase.create({ course: course._id, student: studentB._id, provider: 'stripe', providerCheckoutId: 'cs_2', amountMinor: 5000, currency: 'USD', status: 'paid', paidAt: now });
  // unpaid purchase must never count
  await CoursePurchase.create({ course: course._id, student: studentB._id, provider: 'stripe', providerCheckoutId: 'cs_3', amountMinor: 999900, currency: 'USD', status: 'pending' });

  const res = await invoke(institutionCtrl.generateMonthlyPayroll, { user: teacher, params: { id: institution._id.toString() }, body: { month: now.getMonth() + 1, year: now.getFullYear() } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.created, 1);

  const payslip = await Payslip.findOne({ institution: institution._id, staff: teacher._id });
  assert.equal(payslip.commissionAmount, 15, '10% of (100 + 50) paid revenue = 15, pending purchase excluded');
  assert.equal(payslip.netAmount, 15);
});

test('the background payroll automation generates last month\'s payslip on its own, with nobody ever opening the Payroll page', async () => {
  await TeacherEmployment.create({ institution: institution._id, teacher: teacher._id, offeredBy: teacher._id, status: 'active', salaryType: 'monthly', monthlySalary: 50000, salaryCurrency: 'PKR' });

  // This is the exact call the background scheduler makes (services/feeAutomation.service.js) —
  // note it is never given a request/user context, only the bare institution id.
  await institutionCtrl.runPayrollAutomationForInstitution(institution._id);

  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const payslip = await Payslip.findOne({ institution: institution._id, staff: teacher._id, month: prevMonthDate.getMonth() + 1, year: prevMonthDate.getFullYear() });
  assert.ok(payslip, 'previous month\'s payslip was generated automatically, without the manual button or the Payroll page ever being opened');
  assert.equal(payslip.basicSalary, 50000);

  // Running it again in the same "month" must not create a duplicate payslip.
  await institutionCtrl.runPayrollAutomationForInstitution(institution._id);
  const count = await Payslip.countDocuments({ institution: institution._id, staff: teacher._id, month: prevMonthDate.getMonth() + 1, year: prevMonthDate.getFullYear() });
  assert.equal(count, 1, 'running the automation twice never double-generates the same month');
});
