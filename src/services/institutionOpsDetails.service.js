const Institution = require('../models/Institution');
const Membership = require('../models/StudentInstitutionMembership');
const Employment = require('../models/TeacherEmployment');
const InstitutionProgram = require('../models/InstitutionProgram');
const User = require('../models/User');
const Course = require('../models/Course');
const Fee = require('../models/Fee');
const Attendance = require('../models/Attendance');
const StaffAttendance = require('../models/StaffAttendance');
const Exam = require('../models/Exam');
const ExamSubmission = require('../models/ExamSubmission');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Payslip = require('../models/Payslip');
const Ticket = require('../models/HelpDeskTicket');

// The per-person records behind the AI Operations totals: who paid or owes which fee, each
// student's attendance and graded results per course, each staff member's check-ins and payslips,
// and open help-desk tickets, all labelled with name, category (student/teacher/staff role),
// program and department. Built straight from the database so the screen can show exact tables;
// the AI only explains these rows and never supplies numbers of its own.

const ROW_LIMIT = 300;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const round = (n) => Math.round(n * 100) / 100;
const label = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

// Same rules as the totals in aiOperations.controller summary(), so rows always add up to them.
function feeState(fee) {
  if (['cancelled', 'waived', 'refunded'].includes(fee.status)) return { paid: 0, remaining: 0, state: fee.status };
  const paid = fee.status === 'paid' ? fee.amount : fee.paidAmount || 0;
  const remaining = Math.max(0, fee.outstandingAmount ?? fee.amount - paid);
  let state = 'paid';
  if (remaining > 0) {
    if (fee.status === 'scheduled') state = 'scheduled';
    else if (fee.status === 'overdue' || (fee.dueDate && new Date(fee.dueDate) < new Date())) state = 'overdue';
    else state = paid > 0 ? 'partially paid' : 'pending';
  }
  return { paid, remaining, state };
}

function limited(rows) {
  return { rows: rows.slice(0, ROW_LIMIT), total: rows.length, truncated: rows.length > ROW_LIMIT };
}

async function buildDirectory(institutionId) {
  const [institution, memberships, employment, programs] = await Promise.all([
    Institution.findById(institutionId).select('owner staff').lean(),
    Membership.find({ institution: institutionId }).select('student program status').lean(),
    Employment.find({ institution: institutionId, status: { $in: ['active', 'accepted', 'resigned', 'terminated'] } }).select('teacher role designation department status').lean(),
    InstitutionProgram.find({ institution: institutionId }).select('name department').lean()
  ]);
  const departmentOf = new Map(programs.map((p) => [p.name.trim().toLowerCase(), p.department]));
  const people = new Map();
  const set = (id, info) => { if (id && !people.has(String(id))) people.set(String(id), info); };

  // Active memberships first so a current enrolment wins over an old withdrawn one.
  const ordered = [...memberships].sort((a, b) => (a.status === 'active' ? -1 : 0) - (b.status === 'active' ? -1 : 0));
  for (const m of ordered) {
    set(m.student, {
      category: m.status === 'active' ? 'Student' : `Student (${label(m.status).toLowerCase()})`,
      program: m.program || '',
      department: departmentOf.get((m.program || '').trim().toLowerCase()) || ''
    });
  }
  if (institution?.owner) set(institution.owner, { category: 'Owner', department: '' });
  for (const e of employment) {
    set(e.teacher, { category: `${label(e.role || 'teacher')}${e.status === 'active' || e.status === 'accepted' ? '' : ` (${e.status})`}`, designation: e.designation || '', department: e.department || '' });
  }
  for (const s of institution?.staff || []) {
    set(s.user, { category: label(s.role || 'staff'), designation: s.designation || '', department: s.department || '' });
  }
  const staffIds = [institution?.owner, ...employment.map((e) => e.teacher), ...(institution?.staff || []).map((s) => s.user)].filter(Boolean).map(String);
  return { people, staffIds: [...new Set(staffIds)] };
}

async function details(institutionId) {
  const { people, staffIds } = await buildDirectory(institutionId);
  const courses = await Course.find({ institution: institutionId }).select('_id title subject teacher classSection').populate('classSection', 'name').lean();
  const courseIds = courses.map((c) => c._id);
  const courseOf = new Map(courses.map((c) => [String(c._id), c]));
  const courseName = (id) => {
    const c = courseOf.get(String(id));
    return c ? `${c.title}${c.classSection?.name ? ` (${c.classSection.name})` : ''}` : 'Unlinked class';
  };

  const [fees, attendance, staffAttendance, exams, assignments, payslips, tickets] = await Promise.all([
    Fee.find({ institution: institutionId }).select('student title feeType amount paidAmount outstandingAmount status currency dueDate paidAt').sort({ dueDate: 1 }).lean(),
    Attendance.find({ $or: [{ institution: institutionId }, { course: { $in: courseIds } }] }).select('course date records.student records.status').lean(),
    StaffAttendance.find({ institution: institutionId }).select('staff status date').lean(),
    Exam.find({ course: { $in: courseIds } }).select('course title type questions.marks').lean(),
    Assignment.find({ course: { $in: courseIds } }).select('course title maxMarks').lean(),
    Payslip.find({ institution: institutionId }).select('staff month year netAmount currency status paidAt').sort({ year: -1, month: -1 }).lean(),
    Ticket.find({ institution: institutionId, status: { $in: ['open', 'in_progress'] } }).select('ticketNumber raisedBy category subject priority status createdAt').sort({ createdAt: -1 }).lean()
  ]);
  const [examSubs, assignmentSubs] = await Promise.all([
    ExamSubmission.find({ exam: { $in: exams.map((e) => e._id) }, status: 'graded' }).select('exam student score').lean(),
    Submission.find({ assignment: { $in: assignments.map((a) => a._id) }, status: 'graded' }).select('assignment student marksObtained').lean()
  ]);

  // Names for everyone referenced, including people no longer linked (e.g. a parent's ticket).
  const ids = new Set([
    ...people.keys(), ...fees.map((f) => f.student), ...staffAttendance.map((s) => s.staff), ...payslips.map((p) => p.staff),
    ...tickets.map((t) => t.raisedBy), ...courses.map((c) => c.teacher), ...examSubs.map((s) => s.student), ...assignmentSubs.map((s) => s.student),
    ...attendance.flatMap((a) => a.records.map((r) => r.student))
  ].filter(Boolean).map(String));
  const users = await User.find({ _id: { $in: [...ids] } }).select('fullName roles').lean();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const person = (id) => {
    const info = people.get(String(id)) || {};
    const user = userOf.get(String(id));
    return {
      name: user?.fullName || 'Unknown user',
      category: info.category || (user?.roles?.includes('parent') ? 'Parent' : 'Not linked to this institution'),
      program: info.program || '',
      department: info.department || '',
      designation: info.designation || ''
    };
  };

  const feeRows = fees.map((f) => {
    const p = person(f.student);
    const { paid, remaining, state } = feeState(f);
    return { student: p.name, category: p.category, program: p.program, department: p.department, fee: f.title, feeType: label(f.feeType), currency: f.currency || 'Unknown', amount: f.amount, paid, remaining, state, dueDate: day(f.dueDate), paidOn: day(f.paidAt) };
  });

  const byStudentCourse = new Map();
  for (const a of attendance) {
    for (const r of a.records) {
      const key = `${r.student}|${a.course || ''}`;
      const row = byStudentCourse.get(key) || { studentId: r.student, course: a.course, present: 0, late: 0, halfDay: 0, absent: 0, excused: 0, absentDates: [] };
      if (r.status === 'half_day') row.halfDay++;
      else row[r.status]++;
      if (r.status === 'absent') row.absentDates.push(day(a.date));
      byStudentCourse.set(key, row);
    }
  }
  const attendanceRows = [...byStudentCourse.values()].map(({ studentId, course, absentDates, ...c }) => {
    const p = person(studentId);
    const counted = c.present + c.late + c.halfDay + c.absent;
    return { student: p.name, category: p.category, program: p.program, department: p.department, class: courseName(course), ...c, sessions: counted + c.excused, attendancePercent: counted ? round(((c.present + c.late + c.halfDay * 0.5) / counted) * 100) : null, absentDates: absentDates.sort() };
  }).sort((a, b) => (a.attendancePercent ?? 101) - (b.attendancePercent ?? 101));

  const examOf = new Map(exams.map((e) => [String(e._id), e]));
  const assignmentOf = new Map(assignments.map((a) => [String(a._id), a]));
  const resultRows = [];
  const pushResult = (studentId, courseId, kind, title, score, max) => {
    if (!(max > 0) || score === null || score === undefined) return;
    const p = person(studentId);
    const course = courseOf.get(String(courseId));
    resultRows.push({ student: p.name, program: p.program, department: p.department, class: courseName(courseId), teacher: course?.teacher ? person(course.teacher).name : '', assessment: title, kind, score, maxMarks: max, percent: round((score / max) * 100) });
  };
  for (const s of examSubs) { const e = examOf.get(String(s.exam)); if (e) pushResult(s.student, e.course, label(e.type || 'exam'), e.title, s.score, e.questions.reduce((n, q) => n + (q.marks || 0), 0)); }
  for (const s of assignmentSubs) { const a = assignmentOf.get(String(s.assignment)); if (a) pushResult(s.student, a.course, 'Assignment', a.title, s.marksObtained, a.maxMarks); }
  resultRows.sort((a, b) => a.percent - b.percent);

  const checkIns = new Map();
  for (const s of staffAttendance) {
    const row = checkIns.get(String(s.staff)) || { checkIns: 0, late: 0, lateDates: [], lastCheckIn: null };
    row.checkIns++;
    if (s.status === 'late') { row.late++; row.lateDates.push(day(s.date)); }
    if (!row.lastCheckIn || day(s.date) > row.lastCheckIn) row.lastCheckIn = day(s.date);
    checkIns.set(String(s.staff), row);
  }
  const staffRows = [...new Set([...staffIds, ...checkIns.keys()])].map((id) => {
    const p = person(id);
    const c = checkIns.get(id) || { checkIns: 0, late: 0, lateDates: [], lastCheckIn: null };
    return { name: p.name, category: p.category, designation: p.designation, department: p.department, ...c, lateDates: c.lateDates.sort() };
  });

  const payrollRows = payslips.map((s) => {
    const p = person(s.staff);
    return { name: p.name, category: p.category, department: p.department, period: s.month ? `${MONTHS[s.month - 1]} ${s.year}` : String(s.year || ''), currency: s.currency || 'Unknown', netAmount: s.netAmount, status: s.status, paidOn: day(s.paidAt) };
  });

  const ticketRows = tickets.map((t) => {
    const p = person(t.raisedBy);
    return { ticket: t.ticketNumber, raisedBy: p.name, raisedByCategory: p.category, department: p.department, category: label(t.category), subject: t.subject, priority: t.priority, status: label(t.status), openedOn: day(t.createdAt) };
  });

  return {
    fees: limited(feeRows),
    studentAttendance: limited(attendanceRows),
    results: limited(resultRows),
    staff: limited(staffRows),
    payroll: limited(payrollRows),
    openTickets: limited(ticketRows)
  };
}

module.exports = { details, feeState };
