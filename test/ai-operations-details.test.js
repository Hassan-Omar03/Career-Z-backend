const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// AI Operations "details": per-person rows naming who paid/owes, each student's attendance and
// results with program and department, staff check-ins with role, payslips and ticket raisers.
process.env.NODE_ENV = 'test';
const ai = require('../src/services/ai.service');
let calls = [];
mock.method(ai, 'generate', async (...args) => { calls.push(args); return 'Report'; });
mock.method(ai, 'getAllInstitutionCredentialStatuses', async () => ({ text: { configured: true } }));
const ctrl = require('../src/controllers/aiOperations.controller');
const model = (n) => require(`../src/models/${n}`);
let mongo;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, req) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

test('insights return named per-person records that add up to the totals', async () => {
  const user = (name, roles) => model('User').create({ fullName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@det.local`, passwordHash: 'x', roles });
  const owner = await user('Det Owner', ['institution_owner']);
  const ali = await user('Ali Raza', ['student']);
  const sara = await user('Sara Khan', ['student']);
  const teacher = await user('Tariq Teacher', ['teacher']);
  const accountant = await user('Amna Accounts', ['institution_staff']);
  const parent = await user('Parent Person', ['parent']);
  const inst = await model('Institution').create({ name: 'Detail College', slug: 'detail-college', type: 'college', country: 'PK', owner: owner._id, verificationStatus: 'approved', staff: [{ user: accountant._id, role: 'accountant', designation: 'Senior Accountant', department: 'Finance' }] });
  const section = await model('ClassSection').create({ institution: inst._id, name: 'BSCS Semester 1' });
  await model('InstitutionProgram').create({ institution: inst._id, name: 'BSCS', department: 'Computer Science', classSection: section._id, totalTuitionFee: 100000, createdBy: owner._id });
  await model('StudentInstitutionMembership').create([{ student: ali._id, institution: inst._id, program: 'BSCS', status: 'active' }, { student: sara._id, institution: inst._id, program: 'BSCS', status: 'active' }]);
  await model('TeacherEmployment').create({ teacher: teacher._id, institution: inst._id, role: 'teacher', designation: 'Lecturer', department: 'Computer Science', status: 'active', offeredBy: owner._id });

  await model('Fee').create([
    { institution: inst._id, student: ali._id, recordedBy: owner._id, title: 'Tuition Term 1', feeType: 'tuition', amount: 50000, currency: 'PKR', status: 'paid', paidAt: new Date('2026-09-01') },
    { institution: inst._id, student: sara._id, recordedBy: owner._id, title: 'Tuition Term 1', feeType: 'tuition', amount: 50000, paidAmount: 20000, outstandingAmount: 30000, currency: 'PKR', status: 'partially_paid', dueDate: new Date('2020-01-01') }
  ]);
  const course = await model('Course').create({ institution: inst._id, teacher: teacher._id, title: 'Programming Fundamentals', classSection: section._id });
  await model('Attendance').create([
    { institution: inst._id, course: course._id, date: new Date('2026-10-01'), markedBy: teacher._id, records: [{ student: ali._id, status: 'present' }, { student: sara._id, status: 'absent' }] },
    { institution: inst._id, course: course._id, date: new Date('2026-10-02'), markedBy: teacher._id, records: [{ student: ali._id, status: 'half_day' }, { student: sara._id, status: 'absent' }] }
  ]);
  const exam = await model('Exam').create({ course: course._id, teacher: teacher._id, title: 'Midterm', questions: [{ text: 'Q', marks: 50 }] });
  await model('ExamSubmission').create([{ exam: exam._id, student: ali._id, status: 'graded', score: 45 }, { exam: exam._id, student: sara._id, status: 'graded', score: 20 }]);
  await model('StaffAttendance').create([
    { institution: inst._id, staff: teacher._id, date: new Date('2026-10-01'), checkInAt: new Date('2026-10-01T08:00:00Z'), status: 'present' },
    { institution: inst._id, staff: teacher._id, date: new Date('2026-10-02'), checkInAt: new Date('2026-10-02T09:30:00Z'), status: 'late' }
  ]);
  await model('Payslip').create({ institution: inst._id, staff: accountant._id, month: 9, year: 2026, basicSalary: 80000, netAmount: 76000, currency: 'PKR', status: 'pending', generatedBy: owner._id });
  await model('HelpDeskTicket').create({ institution: inst._id, raisedBy: parent._id, category: 'fee', subject: 'Fee challan missing', description: 'Please resend' });

  const r = await invoke(ctrl.insights, { user: owner, params: { id: inst._id }, body: {} });
  assert.equal(r.status, 200, r.body.message);
  const { details, metrics } = r.body.data;

  const sara1 = details.fees.rows.find((f) => f.student === 'Sara Khan');
  assert.deepEqual({ program: sara1.program, department: sara1.department, category: sara1.category, paid: sara1.paid, remaining: sara1.remaining, state: sara1.state, feeType: sara1.feeType },
    { program: 'BSCS', department: 'Computer Science', category: 'Student', paid: 20000, remaining: 30000, state: 'overdue', feeType: 'Tuition' });
  assert.equal(details.fees.rows.find((f) => f.student === 'Ali Raza').paidOn, '2026-09-01');
  const collected = details.fees.rows.reduce((n, f) => n + f.paid, 0);
  assert.equal(collected, metrics.feesByCurrency.PKR.collected);

  const saraAtt = details.studentAttendance.rows[0];
  assert.equal(saraAtt.student, 'Sara Khan');
  assert.equal(saraAtt.class, 'Programming Fundamentals (BSCS Semester 1)');
  assert.deepEqual(saraAtt.absentDates, ['2026-10-01', '2026-10-02']);
  assert.equal(saraAtt.attendancePercent, 0);
  assert.equal(details.studentAttendance.rows.find((a) => a.student === 'Ali Raza').attendancePercent, 75);
  assert.equal(metrics.studentAttendance.attendancePercent, 37.5);

  assert.deepEqual(details.results.rows.map((x) => [x.student, x.percent, x.teacher]), [['Sara Khan', 40, 'Tariq Teacher'], ['Ali Raza', 90, 'Tariq Teacher']]);

  const tariq = details.staff.rows.find((s) => s.name === 'Tariq Teacher');
  assert.deepEqual({ category: tariq.category, designation: tariq.designation, department: tariq.department, checkIns: tariq.checkIns, late: tariq.late, lateDates: tariq.lateDates },
    { category: 'Teacher', designation: 'Lecturer', department: 'Computer Science', checkIns: 2, late: 1, lateDates: ['2026-10-02'] });
  const amna = details.staff.rows.find((s) => s.name === 'Amna Accounts');
  assert.equal(amna.category, 'Accountant');
  assert.equal(amna.checkIns, 0);
  assert.equal(details.staff.rows.find((s) => s.name === 'Det Owner').category, 'Owner');

  assert.deepEqual(details.payroll.rows.map((p) => [p.name, p.period, p.status, p.netAmount]), [['Amna Accounts', 'Sep 2026', 'pending', 76000]]);
  assert.deepEqual(details.openTickets.rows.map((t) => [t.raisedBy, t.raisedByCategory, t.category]), [['Parent Person', 'Parent', 'Fee']]);

  // The AI receives the same named records, and only through the institution's own key.
  const sent = JSON.parse(calls[0][2]);
  assert.equal(sent.records.fees.rows.length, 2);
  assert.match(calls[0][2], /Sara Khan/);
  assert.equal(String(calls[0][3]), String(inst._id));

  // Every generated report is saved with its records and can be reopened, listed and deleted
  // by the same people who may generate one; nobody else can see it.
  const reportId = r.body.data.reportId;
  assert.ok(reportId);
  const ask = (handler, who, params = {}) => invoke(handler, { user: who, params: { id: inst._id, ...params }, body: {} });
  const listed = await ask(ctrl.listReports, owner);
  assert.deepEqual(listed.body.data.map((x) => [String(x._id), x.generatedBy]), [[String(reportId), 'Det Owner']]);
  const opened = await ask(ctrl.getReport, owner, { reportId });
  assert.equal(opened.body.data.insights, 'Report');
  assert.equal(opened.body.data.details.fees.rows.find((f) => f.student === 'Sara Khan').remaining, 30000);
  for (const who of [ali, teacher, accountant]) {
    assert.equal((await ask(ctrl.listReports, who)).status, 403);
    assert.equal((await ask(ctrl.getReport, who, { reportId })).status, 403);
    assert.equal((await ask(ctrl.deleteReport, who, { reportId })).status, 403);
  }
  assert.equal((await ask(ctrl.deleteReport, owner, { reportId })).status, 200);
  assert.equal((await ask(ctrl.getReport, owner, { reportId })).status, 404);
});
