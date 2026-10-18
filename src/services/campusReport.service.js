const Campus = require('../models/Campus');
const ClassSection = require('../models/ClassSection');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const Fee = require('../models/Fee');
const TimetableEntry = require('../models/TimetableEntry');
const Membership = require('../models/StudentInstitutionMembership');

// Per-campus report from real records. A campus owns the class sections assigned to it; a
// student belongs to the campus of the sections whose courses they are enrolled in (first one,
// so nobody is counted twice); fees follow the student. Active members not yet placed in any
// campus section are reported under "Not assigned to a campus" so totals add up.

const UNASSIGNED = 'unassigned';

async function campusReport(institutionId, { from, to } = {}) {
  const start = from ? new Date(from) : new Date(Date.now() - 30 * 864e5);
  const end = new Date(`${(to ? String(to) : new Date().toISOString()).slice(0, 10)}T23:59:59.999Z`); // to the end of that day, so today's later sessions count
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw Object.assign(new Error('Choose a valid date range.'), { statusCode: 422 });

  const [campuses, sections, courses, members] = await Promise.all([
    Campus.find({ institution: institutionId }).select('name city isMain').sort({ isMain: -1, name: 1 }).lean(),
    ClassSection.find({ institution: institutionId }).select('name campus').lean(),
    Course.find({ institution: institutionId }).select('classSection teacher').lean(),
    Membership.distinct('student', { institution: institutionId, status: 'active' })
  ]);
  const campusOfSection = new Map(sections.map((s) => [String(s._id), s.campus ? String(s.campus) : UNASSIGNED]));
  const campusOfCourse = new Map(courses.map((c) => [String(c._id), c.classSection ? campusOfSection.get(String(c.classSection)) || UNASSIGNED : UNASSIGNED]));

  const enrollments = await Enrollment.find({ course: { $in: courses.map((c) => c._id) }, status: { $ne: 'dropped' } }).select('student course createdAt').sort({ createdAt: 1 }).lean();
  const campusOfStudent = new Map();
  for (const e of enrollments) {
    const campus = campusOfCourse.get(String(e.course));
    const key = String(e.student);
    if (!campusOfStudent.has(key) || (campusOfStudent.get(key) === UNASSIGNED && campus !== UNASSIGNED)) campusOfStudent.set(key, campus);
  }
  for (const s of members) if (!campusOfStudent.has(String(s))) campusOfStudent.set(String(s), UNASSIGNED);

  const rows = new Map([...campuses.map((c) => [String(c._id), { _id: c._id, name: c.name, city: c.city || '', isMain: Boolean(c.isMain) }]), [UNASSIGNED, { _id: null, name: 'Not assigned to a campus', city: '', isMain: false }]]);
  for (const r of rows.values()) Object.assign(r, { sections: 0, students: 0, teachers: new Set(), attendance: { present: 0, late: 0, half_day: 0, absent: 0, excused: 0, sessions: 0 }, fees: {} });
  for (const s of sections) rows.get(campusOfSection.get(String(s._id)) || UNASSIGNED).sections += 1;
  for (const campus of campusOfStudent.values()) rows.get(campus || UNASSIGNED).students += 1;
  for (const c of courses) if (c.teacher) rows.get(campusOfCourse.get(String(c._id)) || UNASSIGNED).teachers.add(String(c.teacher));
  const slots = await TimetableEntry.find({ institution: institutionId, teacher: { $ne: null } }).select('classSection teacher').lean();
  for (const t of slots) rows.get(campusOfSection.get(String(t.classSection)) || UNASSIGNED).teachers.add(String(t.teacher));

  const sessions = await Attendance.find({ date: { $gte: start, $lte: end }, $or: [{ institution: institutionId }, { course: { $in: courses.map((c) => c._id) } }] }).select('classSection course records.status').lean();
  for (const a of sessions) {
    const campus = a.classSection ? campusOfSection.get(String(a.classSection)) : a.course ? campusOfCourse.get(String(a.course)) : UNASSIGNED;
    const row = rows.get(campus || UNASSIGNED);
    row.attendance.sessions += 1;
    for (const r of a.records || []) if (row.attendance[r.status] !== undefined) row.attendance[r.status] += 1;
  }

  const fees = await Fee.find({ institution: institutionId, status: { $nin: ['cancelled', 'waived', 'refunded'] } }).select('student amount paidAmount outstandingAmount status currency dueDate').lean();
  const now = new Date();
  for (const f of fees) {
    const row = rows.get(campusOfStudent.get(String(f.student)) || UNASSIGNED);
    const m = row.fees[f.currency || 'Unknown'] ??= { billed: 0, collected: 0, outstanding: 0, overdue: 0, overdueCount: 0 };
    const paid = f.status === 'paid' ? f.amount : f.paidAmount || 0;
    const remaining = Math.max(0, f.outstandingAmount ?? f.amount - paid);
    m.billed += f.amount || 0; m.collected += paid; m.outstanding += remaining;
    if (remaining > 0 && (f.status === 'overdue' || (f.dueDate && f.dueDate < now && f.status !== 'scheduled'))) { m.overdue += remaining; m.overdueCount += 1; }
  }

  const campusesOut = [...rows.values()].filter((r) => r._id || r.sections || r.students || Object.keys(r.fees).length).map((r) => {
    const a = r.attendance;
    const counted = a.present + a.late + a.half_day + a.absent;
    return { ...r, teachers: r.teachers.size, attendance: { ...a, percent: counted ? Math.round(((a.present + a.late + a.half_day * 0.5) / counted) * 1000) / 10 : null } };
  });
  return { from: start, to: end, campuses: campusesOut, note: 'Attendance excludes excused records. Different currencies are never added together.' };
}

module.exports = { campusReport };
