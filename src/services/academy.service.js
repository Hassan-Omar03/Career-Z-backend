const mongoose = require('mongoose');
const Batch = require('../models/Batch');
const BatchEnrollment = require('../models/BatchEnrollment');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Fee = require('../models/Fee');
const Institution = require('../models/Institution');
const Membership = require('../models/StudentInstitutionMembership');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { hasStaffPermission } = require('../utils/staffRoles');
const { notify } = require('./notification.service');

// Academy flow (master 15A.6, Student 3–4): Course → Batch → Students.
//   The academy makes courses and batches (teacher, days/times, dates, seats, fee, admission).
//   A student joins a batch: a seat at once (auto) or after the academy accepts (approval);
//   when the batch is full they wait in line and move up when a seat frees.
//   An active seat enrols the student in the course (lessons, assignments, attendance,
//   progress), makes them a member of the academy (never replacing their primary school),
//   and bills the fee: once, or every month of the batch.

const fail = (message, status = 422) => new AppError(message, status);
const oid = (id) => mongoose.isValidObjectId(id);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const OPEN = ['pending', 'waitlisted', 'active'];
const PERM = 'students:manage';
const month = (d) => new Date(d).toISOString().slice(0, 7);

async function managedInstitution(user, institutionId) {
  if (!oid(institutionId)) throw fail('Institute not found.', 404);
  const inst = await Institution.findById(institutionId);
  if (!inst) throw fail('Institute not found.', 404);
  if (!hasStaffPermission(inst, user._id, PERM)) throw fail('Only the institute owner or staff who manage students can do this.', 403);
  return inst;
}
async function managedBatch(user, batchId) {
  if (!oid(batchId)) throw fail('Batch not found.', 404);
  const batch = await Batch.findById(batchId);
  if (!batch) throw fail('Batch not found.', 404);
  const inst = await managedInstitution(user, batch.institution);
  return { batch, inst };
}
const seatsTaken = (batchId) => BatchEnrollment.countDocuments({ batch: batchId, status: 'active' });

// ---------------------------------------------------------------- batches (academy side)
function cleanBatch(body, inst, existing) {
  const out = {};
  const str = (k, n) => { if (body[k] !== undefined) out[k] = String(body[k] || '').trim().slice(0, n); };
  str('name', 80); str('description', 1500); str('room', 80);
  if (existing ? out.name === '' : !out.name || out.name.length < 2) throw fail('Give the batch a name, e.g. "Morning A" or "Weekend 2026".');
  if (body.meetingLink !== undefined) {
    const link = String(body.meetingLink || '').trim();
    if (link && !/^https:\/\//.test(link)) throw fail('The online class link must start with https://.');
    out.meetingLink = link.slice(0, 300);
  }
  if (body.mode !== undefined) { if (!['on_campus', 'online', 'hybrid'].includes(body.mode)) throw fail('Choose on campus, online or hybrid.'); out.mode = body.mode; }
  if (body.schedule !== undefined) {
    const list = [].concat(body.schedule || []);
    if (!list.length) throw fail('Add at least one class day and time.');
    out.schedule = list.slice(0, 14).map((s) => {
      if (!DAYS.includes(s.day) || !TIME.test(s.start || '') || !TIME.test(s.end || '') || s.start >= s.end) throw fail('Each class needs a day and a start time before the end time (e.g. 16:00 to 17:30).');
      return { day: s.day, start: s.start, end: s.end };
    });
  } else if (!existing) throw fail('Add at least one class day and time.');
  if (body.startDate !== undefined || !existing) {
    const d = new Date(body.startDate);
    if (Number.isNaN(d.getTime())) throw fail('Choose the start date.');
    out.startDate = d;
  }
  if (body.endDate !== undefined) {
    if (!body.endDate) out.endDate = null;
    else { const d = new Date(body.endDate); if (Number.isNaN(d.getTime())) throw fail('Choose a valid end date.'); out.endDate = d; }
  }
  const start = out.startDate || existing?.startDate, end = out.endDate !== undefined ? out.endDate : existing?.endDate;
  if (start && end && end <= start) throw fail('The end date must be after the start date.');
  if (body.seats !== undefined || !existing) { const n = Number(body.seats); if (!Number.isInteger(n) || n < 1 || n > 1000) throw fail('Seats must be a whole number from 1 to 1000.'); out.seats = n; }
  if (body.fee !== undefined) {
    const amount = Number(body.fee?.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw fail('The fee cannot be negative.');
    const period = body.fee?.period === 'one_time' ? 'one_time' : 'monthly';
    out.fee = { amount: Math.round(amount * 100) / 100, currency: String(body.fee?.currency || 'PKR').toUpperCase().slice(0, 3), period };
  }
  if (body.admission !== undefined) { if (!['auto', 'approval'].includes(body.admission)) throw fail('Choose automatic seats or approval.'); out.admission = body.admission; }
  if (body.status !== undefined) { if (!['draft', 'open', 'closed', 'completed', 'cancelled'].includes(body.status)) throw fail('Choose a valid batch status.'); out.status = body.status; }
  if (body.teacher !== undefined) {
    if (body.teacher && !(String(inst.owner) === String(body.teacher) || inst.staff.some((s) => String(s.user) === String(body.teacher)))) throw fail('The teacher must be on this institute\'s staff.');
    out.teacher = body.teacher || null;
  }
  return out;
}

// A course for the batch: an existing course of this institute, or a new one made here.
async function courseFor(user, inst, body) {
  if (body.courseId) {
    if (!oid(body.courseId)) throw fail('Course not found.', 404);
    const c = await Course.findOne({ _id: body.courseId, institution: inst._id });
    if (!c) throw fail('Choose one of this institute\'s courses.', 404);
    return c;
  }
  const title = String(body.courseTitle || '').trim().slice(0, 120);
  if (title.length < 2) throw fail('Choose a course, or write the name of a new course.');
  return Course.create({ title, institution: inst._id, teacher: body.teacher || user._id, subject: String(body.subject || '').slice(0, 80), studyMode: body.mode === 'online' ? 'online' : body.mode === 'hybrid' ? 'hybrid' : 'physical', isFree: !(Number(body.fee?.amount) > 0), price: Number(body.fee?.amount) || 0, published: true });
}

async function createBatch(user, institutionId, body = {}) {
  const inst = await managedInstitution(user, institutionId);
  const data = cleanBatch(body, inst, null);
  const course = await courseFor(user, inst, body);
  return Batch.create({ ...data, institution: inst._id, course: course._id, teacher: data.teacher ?? (String(course.teacher) === String(user._id) ? null : course.teacher), createdBy: user._id });
}

async function updateBatch(user, batchId, body = {}) {
  const { batch, inst } = await managedBatch(user, batchId);
  const data = cleanBatch(body, inst, batch);
  if (data.seats !== undefined && data.seats < await seatsTaken(batch._id)) throw fail(`${await seatsTaken(batch._id)} students already have a seat; seats cannot be fewer.`);
  const finishing = data.status && ['completed', 'cancelled'].includes(data.status) && !['completed', 'cancelled'].includes(batch.status);
  Object.assign(batch, data);
  await batch.save();
  if (data.seats !== undefined) await fillFromWaitlist(batch);
  if (finishing) await finishBatch(batch, user);
  return batch;
}

// Finished or cancelled: active students complete (or end), waiting ones are told.
async function finishBatch(batch, user) {
  const rows = await BatchEnrollment.find({ batch: batch._id, status: { $in: OPEN } });
  for (const e of rows) {
    const done = batch.status === 'completed' && e.status === 'active';
    e.status = done ? 'completed' : 'left';
    e.endedAt = new Date();
    e.reason = batch.status === 'cancelled' ? 'The academy cancelled this batch' : done ? '' : 'The batch finished before a seat opened';
    e.decidedBy = user._id;
    await e.save();
    if (done) await Enrollment.updateOne({ student: e.student, course: batch.course, status: 'active' }, { $set: { status: 'completed', completedAt: new Date() } });
    await Fee.updateMany({ student: e.student, batch: batch._id, status: { $in: ['scheduled', 'pending'] }, dueDate: { $gt: new Date() } }, { $set: { status: 'cancelled' } });
    await notify(e.student, { title: `${batch.name}: ${batch.status === 'completed' ? 'completed' : 'cancelled'}`, body: e.reason || 'Well done on finishing the batch.', category: 'academy' }).catch(() => {});
  }
}

async function listBatches(user, institutionId) {
  const inst = await managedInstitution(user, institutionId);
  const batches = await Batch.find({ institution: inst._id }).populate('course', 'title subject').populate('teacher', 'fullName').sort({ startDate: -1 }).lean();
  const counts = await BatchEnrollment.aggregate([{ $match: { batch: { $in: batches.map((b) => b._id) } } }, { $group: { _id: { b: '$batch', s: '$status' }, n: { $sum: 1 } } }]);
  const by = (b, s) => counts.find((c) => String(c._id.b) === String(b) && c._id.s === s)?.n || 0;
  const courses = await Course.find({ institution: inst._id }).select('title subject teacher').lean();
  const staff = await User.find({ _id: { $in: [inst.owner, ...inst.staff.map((s) => s.user)] } }).select('fullName').lean();
  return { institution: { _id: inst._id, name: inst.name, type: inst.type }, courses, teachers: staff, batches: batches.map((b) => ({ ...b, active: by(b._id, 'active'), pending: by(b._id, 'pending'), waitlisted: by(b._id, 'waitlisted'), seatsLeft: Math.max(0, b.seats - by(b._id, 'active')) })) };
}

async function roster(user, batchId) {
  if (!oid(batchId)) throw fail('Batch not found.', 404);
  const batch = await Batch.findById(batchId).populate('course', 'title');
  if (!batch) throw fail('Batch not found.', 404);
  const inst = await Institution.findById(batch.institution).select('owner staff');
  if (!hasStaffPermission(inst, user._id, PERM) && String(batch.teacher) !== String(user._id)) throw fail('Only the academy or the batch teacher can see the students.', 403);
  const rows = await BatchEnrollment.find({ batch: batch._id }).populate('student', 'fullName email phone').sort({ status: 1, requestedAt: 1 }).lean();
  const fees = await Fee.find({ batch: batch._id }).select('student amount status billingPeriod currency').lean();
  const progress = await Enrollment.find({ course: batch.course._id, student: { $in: rows.map((r) => r.student?._id) } }).select('student progressPercent').lean();
  const attendance = await attendanceFor(batch, rows.map((r) => r.student?._id));
  return {
    batch,
    students: rows.map((r) => ({
      ...r,
      progress: progress.find((p) => String(p.student) === String(r.student?._id))?.progressPercent ?? 0,
      attendance: attendance.get(String(r.student?._id)) ?? null,
      feesDue: fees.filter((f) => String(f.student) === String(r.student?._id) && ['pending', 'overdue', 'partially_paid'].includes(f.status)).reduce((s, f) => s + f.amount, 0),
      feesPaid: fees.filter((f) => String(f.student) === String(r.student?._id) && f.status === 'paid').reduce((s, f) => s + f.amount, 0)
    }))
  };
}

// Attendance % for the course's sessions held since the batch started.
async function attendanceFor(batch, studentIds) {
  const sessions = await require('../models/AttendanceSession').find({ course: batch.course?._id || batch.course, date: { $gte: batch.startDate } }).select('checkedIn').lean();
  const out = new Map();
  if (!sessions.length) return out;
  for (const id of studentIds.filter(Boolean)) out.set(String(id), Math.round(100 * sessions.filter((s) => (s.checkedIn || []).some((c) => String(c) === String(id))).length / sessions.length));
  return out;
}

// ---------------------------------------------------------------- joining (student side)
async function publicBatches(institutionId) {
  if (!oid(institutionId)) throw fail('Institute not found.', 404);
  const batches = await Batch.find({ institution: institutionId, status: 'open' }).populate('course', 'title subject description').populate('teacher', 'fullName').sort({ startDate: 1 }).lean();
  const counts = await BatchEnrollment.aggregate([{ $match: { batch: { $in: batches.map((b) => b._id) }, status: 'active' } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]);
  return batches.map((b) => ({ _id: b._id, name: b.name, description: b.description, course: b.course, teacher: b.teacher ? { fullName: b.teacher.fullName } : null, schedule: b.schedule, mode: b.mode, room: b.room, startDate: b.startDate, endDate: b.endDate, seats: b.seats, seatsLeft: Math.max(0, b.seats - (counts.find((c) => String(c._id) === String(b._id))?.n || 0)), fee: b.fee, admission: b.admission }));
}

async function join(user, batchId, note) {
  if (!(user.roles || []).includes('student')) throw fail('Only a student account can join a batch.', 403);
  if (!oid(batchId)) throw fail('Batch not found.', 404);
  const batch = await Batch.findById(batchId).populate('course', 'title');
  if (!batch || batch.status !== 'open') throw fail('This batch is not taking students now.', 409);
  if (batch.endDate && batch.endDate < new Date()) throw fail('This batch has already ended.', 409);
  let e = await BatchEnrollment.findOne({ batch: batch._id, student: user._id });
  if (e && OPEN.includes(e.status)) throw fail(e.status === 'active' ? 'You are already in this batch.' : 'Your request for this batch is already waiting.', 409);
  if (!e) e = new BatchEnrollment({ batch: batch._id, student: user._id, institution: batch.institution });
  Object.assign(e, { status: 'pending', note: String(note || '').trim().slice(0, 500), requestedAt: new Date(), endedAt: null, reason: '', decidedBy: null, transferredTo: null });
  if (batch.admission === 'auto') e.status = (await seatsTaken(batch._id)) < batch.seats ? 'active' : 'waitlisted';
  await e.save();
  if (e.status === 'active') await activate(e, batch);
  const inst = await Institution.findById(batch.institution).select('owner name');
  await notify(inst.owner, { title: e.status === 'pending' ? `Batch request: ${user.fullName} → ${batch.name}` : e.status === 'active' ? `${user.fullName} joined ${batch.name}` : `${user.fullName} is waiting for a seat in ${batch.name}`, link: '/dashboard?ws=institution&tab=batches', category: 'academy' }).catch(() => {});
  return e;
}

// A seat: course enrolment, academy membership (not primary) and the first fee.
async function activate(e, batchDoc) {
  const batch = batchDoc?.course?.title ? batchDoc : await Batch.findById(e.batch).populate('course', 'title');
  e.status = 'active';
  e.activatedAt = new Date();
  await e.save();
  await Enrollment.updateOne({ student: e.student, course: batch.course._id }, { $set: { status: 'active' }, $setOnInsert: { enrolledAt: new Date() } }, { upsert: true });
  const m = await Membership.findOne({ student: e.student, institution: batch.institution });
  if (!m) await Membership.create({ student: e.student, institution: batch.institution, status: 'active', program: batch.course.title, isPrimary: false, requestedAction: '' });
  else if (!['active', 'withdrawal_requested', 'transfer_requested'].includes(m.status)) { m.status = 'active'; m.leftAt = null; m.program = m.program || batch.course.title; await m.save(); }
  await bill(e, batch);
  await notify(e.student, { title: `You have a seat in ${batch.name} (${batch.course.title})`, body: `Starts ${new Date(batch.startDate).toDateString()}.${batch.fee.amount > 0 ? ` Fee: ${batch.fee.currency} ${batch.fee.amount}${batch.fee.period === 'monthly' ? ' a month' : ''}.` : ''}`, link: '/dashboard?tab=myAcademies', category: 'academy' }, { email: true }).catch(() => {});
  await notifyParents(e.student, `Your child joined ${batch.name} (${batch.course.title})`);
}
async function notifyParents(studentId, title) {
  const links = await require('../models/ParentChildLink').find({ student: studentId, status: 'approved' }).select('parent').lean();
  for (const l of links) await notify(l.parent, { title, link: '/dashboard?ws=parent', category: 'academy' }).catch(() => {});
}

// Fees: one-time once; monthly for every month from the batch start (or joining) up to now,
// never past the end date. Called on activation and whenever fees are looked at.
async function bill(e, batchDoc) {
  const batch = batchDoc || await Batch.findById(e.batch).populate('course', 'title');
  if (e.status !== 'active' || !(batch.fee?.amount > 0)) return;
  if (batch.fee.period === 'one_time') {
    if (e.billedThrough) return;
    await Fee.create({ student: e.student, institution: batch.institution, batch: batch._id, title: `${batch.course.title}: ${batch.name} (full course)`, feeType: 'tuition', recordedBy: await ownerOf(batch.institution), amount: batch.fee.amount, currency: batch.fee.currency, dueDate: new Date(Math.max(Date.now(), new Date(batch.startDate).getTime())), status: 'pending', billingPeriod: 'one-time' });
    e.billedThrough = 'one-time';
    await e.save();
    return;
  }
  // From the later of the batch start and joining; a batch that starts later bills its first month now.
  const first = month(new Date(Math.max(new Date(batch.startDate).getTime(), new Date(e.activatedAt || Date.now()).getTime())));
  const endMonth = batch.endDate ? month(batch.endDate) : null;
  let last = month(new Date()) < first ? first : month(new Date());
  if (endMonth && last > endMonth) last = endMonth;
  let cur = e.billedThrough && e.billedThrough !== 'one-time' ? nextMonth(e.billedThrough) : first;
  while (cur <= last) {
    if (!(await Fee.exists({ student: e.student, batch: batch._id, billingPeriod: cur }))) {
      await Fee.create({ student: e.student, institution: batch.institution, batch: batch._id, title: `${batch.course.title}: ${batch.name} (${new Date(`${cur}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`, feeType: 'tuition', recordedBy: await ownerOf(batch.institution), amount: batch.fee.amount, currency: batch.fee.currency, dueDate: new Date(`${cur}-10T23:59:59.000Z`), status: 'pending', billingPeriod: cur });
    }
    e.billedThrough = cur;
    cur = nextMonth(cur);
  }
  await e.save();
}
const ownerCache = new Map();
async function ownerOf(institutionId) {
  const k = String(institutionId?._id || institutionId);
  if (!ownerCache.has(k)) ownerCache.set(k, (await Institution.findById(k).select('owner').lean())?.owner);
  return ownerCache.get(k);
}
function nextMonth(ym) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }

async function billAll(filter) {
  const rows = await BatchEnrollment.find({ ...filter, status: 'active' });
  for (const e of rows) await bill(e).catch(() => {});
}

// The academy accepts or declines a request; accepted with no seat left → waiting list.
async function decide(user, enrollmentId, { approve, reason } = {}) {
  if (!oid(enrollmentId)) throw fail('Request not found.', 404);
  const e = await BatchEnrollment.findById(enrollmentId);
  if (!e) throw fail('Request not found.', 404);
  const { batch } = await managedBatch(user, e.batch);
  if (!['pending', 'waitlisted'].includes(e.status)) throw fail('This request was already answered.', 409);
  e.decidedBy = user._id;
  if (!approve) {
    e.status = 'rejected';
    e.reason = String(reason || '').trim().slice(0, 300);
    e.endedAt = new Date();
    await e.save();
    await notify(e.student, { title: `${batch.name}: request not accepted`, body: e.reason, category: 'academy' }).catch(() => {});
    return e;
  }
  if ((await seatsTaken(batch._id)) >= batch.seats) {
    e.status = 'waitlisted';
    await e.save();
    await notify(e.student, { title: `${batch.name} is full: you are on the waiting list`, body: 'You get the next free seat.', category: 'academy' }).catch(() => {});
    return e;
  }
  await activate(e, await Batch.findById(batch._id).populate('course', 'title'));
  return e;
}

// Free seats go to the waiting list in order.
async function fillFromWaitlist(batchDoc) {
  const batch = await Batch.findById(batchDoc._id).populate('course', 'title');
  if (batch.status !== 'open') return;
  let free = batch.seats - await seatsTaken(batch._id);
  if (free <= 0) return;
  const waiting = await BatchEnrollment.find({ batch: batch._id, status: 'waitlisted' }).sort({ requestedAt: 1 }).limit(free);
  for (const e of waiting) { if (free-- <= 0) break; await activate(e, batch); }
}

// The student leaves (or the academy removes them): future unpaid fees are cancelled.
async function endSeat(e, batch, reason, by) {
  const wasActive = e.status === 'active';
  e.status = 'left';
  e.endedAt = new Date();
  e.reason = String(reason || '').trim().slice(0, 300);
  e.decidedBy = by;
  await e.save();
  await Fee.updateMany({ student: e.student, batch: batch._id, status: { $in: ['scheduled', 'pending'] }, dueDate: { $gt: new Date() } }, { $set: { status: 'cancelled' } });
  if (wasActive && !(await BatchEnrollment.exists({ student: e.student, status: 'active', batch: { $in: await Batch.distinct('_id', { course: batch.course }) } }))) {
    await Enrollment.updateOne({ student: e.student, course: batch.course, status: 'active' }, { $set: { status: 'dropped' } });
  }
  if (wasActive) await fillFromWaitlist(batch);
}

async function leave(user, enrollmentId, reason) {
  if (!oid(enrollmentId)) throw fail('Not found.', 404);
  const e = await BatchEnrollment.findOne({ _id: enrollmentId, student: user._id });
  if (!e || !OPEN.includes(e.status)) throw fail('You are not in this batch.', 404);
  const batch = await Batch.findById(e.batch);
  await endSeat(e, batch, reason || 'Left by the student', user._id);
  const inst = await Institution.findById(batch.institution).select('owner');
  await notify(inst.owner, { title: `${user.fullName} left ${batch.name}`, body: reason || '', category: 'academy' }).catch(() => {});
  return e;
}

async function removeStudent(user, enrollmentId, reason) {
  if (!oid(enrollmentId)) throw fail('Not found.', 404);
  const e = await BatchEnrollment.findById(enrollmentId);
  if (!e || !OPEN.includes(e.status)) throw fail('This student is not in the batch.', 404);
  const { batch } = await managedBatch(user, e.batch);
  if (!String(reason || '').trim()) throw fail('Write the reason; the student is told.');
  await endSeat(e, batch, reason, user._id);
  await notify(e.student, { title: `You were removed from ${batch.name}`, body: reason, category: 'academy' }).catch(() => {});
  return e;
}

// Move to another batch of the same academy (e.g. morning → evening): seat there first.
async function transfer(user, enrollmentId, toBatchId) {
  if (!oid(enrollmentId)) throw fail('Not found.', 404);
  const e = await BatchEnrollment.findOne({ _id: enrollmentId, student: user._id, status: 'active' });
  if (!e) throw fail('You can move only from a batch you are in.', 404);
  const from = await Batch.findById(e.batch);
  if (!oid(toBatchId)) throw fail('Choose the batch to move to.');
  const to = await Batch.findById(toBatchId).populate('course', 'title');
  if (!to || String(to.institution) !== String(from.institution) || String(to._id) === String(from._id)) throw fail('Choose another batch of the same academy.');
  if (to.status !== 'open') throw fail('That batch is not taking students now.', 409);
  if ((await seatsTaken(to._id)) >= to.seats) throw fail('That batch is full. Join its waiting list instead.', 409);
  let ne = await BatchEnrollment.findOne({ batch: to._id, student: user._id });
  if (ne && OPEN.includes(ne.status)) throw fail('You are already in that batch.', 409);
  if (!ne) ne = new BatchEnrollment({ batch: to._id, student: user._id, institution: to.institution });
  Object.assign(ne, { status: 'active', requestedAt: new Date(), endedAt: null, reason: `Moved from ${from.name}`, billedThrough: String(from._id) === String(to._id) ? ne.billedThrough : (to.fee.period === from.fee.period && to.fee.amount === from.fee.amount ? e.billedThrough : '') });
  await ne.save();
  await activate(ne, to);
  await endSeat(e, from, `Moved to ${to.name}`, user._id);
  e.status = 'transferred';
  e.transferredTo = to._id;
  await e.save();
  return ne;
}

// ---------------------------------------------------------------- views
async function shape(rows) {
  const batches = await Batch.find({ _id: { $in: rows.map((r) => r.batch) } }).populate('course', 'title subject').populate('teacher', 'fullName').populate('institution', 'name type city logo').lean();
  const fees = await Fee.find({ batch: { $in: batches.map((b) => b._id) }, student: { $in: rows.map((r) => r.student) } }).select('student batch title amount currency status dueDate billingPeriod paidAt').sort({ dueDate: 1 }).lean();
  const progress = await Enrollment.find({ student: { $in: rows.map((r) => r.student) }, course: { $in: batches.map((b) => b.course?._id) } }).select('student course progressPercent').lean();
  const out = [];
  for (const r of rows) {
    const b = batches.find((x) => String(x._id) === String(r.batch));
    if (!b) continue;
    const att = await attendanceFor(b, [r.student]);
    out.push({ ...r, batch: b, fees: fees.filter((f) => String(f.batch) === String(b._id) && String(f.student) === String(r.student)), progress: progress.find((p) => String(p.student) === String(r.student) && String(p.course) === String(b.course?._id))?.progressPercent ?? 0, attendance: att.get(String(r.student)) ?? null });
  }
  return out;
}
async function mine(user) {
  await billAll({ student: user._id });
  return shape(await BatchEnrollment.find({ student: user._id }).sort({ requestedAt: -1 }).lean());
}
async function childBatches(user, studentId) {
  if (!oid(studentId)) throw fail('Child not found.', 404);
  const link = await require('../models/ParentChildLink').exists({ parent: user._id, student: studentId, status: 'approved' });
  if (!link) throw fail('Child not found.', 404);
  await billAll({ student: studentId });
  return shape(await BatchEnrollment.find({ student: studentId, status: { $in: ['pending', 'waitlisted', 'active', 'completed'] } }).sort({ requestedAt: -1 }).lean());
}
async function teaching(user) {
  const batches = await Batch.find({ teacher: user._id, status: { $in: ['open', 'closed', 'completed'] } }).populate('course', 'title').populate('institution', 'name').sort({ startDate: -1 }).lean();
  const counts = await BatchEnrollment.aggregate([{ $match: { batch: { $in: batches.map((b) => b._id) }, status: 'active' } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]);
  return batches.map((b) => ({ ...b, students: counts.find((c) => String(c._id) === String(b._id))?.n || 0 }));
}

// Academy report: seats, waiting, fee billed/collected and attendance per batch.
async function report(user, institutionId) {
  const inst = await managedInstitution(user, institutionId);
  await billAll({ institution: inst._id });
  const batches = await Batch.find({ institution: inst._id }).populate('course', 'title').lean();
  const rows = [];
  for (const b of batches) {
    const es = await BatchEnrollment.find({ batch: b._id }).select('student status').lean();
    const active = es.filter((e) => e.status === 'active');
    const fees = await Fee.find({ batch: b._id }).select('amount status').lean();
    const att = await attendanceFor(b, active.map((e) => e.student));
    const vals = [...att.values()];
    rows.push({ _id: b._id, name: b.name, course: b.course?.title, status: b.status, seats: b.seats, active: active.length, waiting: es.filter((e) => e.status === 'waitlisted').length, pending: es.filter((e) => e.status === 'pending').length, left: es.filter((e) => ['left', 'transferred'].includes(e.status)).length, completed: es.filter((e) => e.status === 'completed').length, billed: fees.filter((f) => f.status !== 'cancelled').reduce((s, f) => s + f.amount, 0), collected: fees.filter((f) => f.status === 'paid').reduce((s, f) => s + f.amount, 0), attendance: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null });
  }
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return { totals: { batches: rows.length, open: rows.filter((r) => r.status === 'open').length, students: sum('active'), waiting: sum('waiting'), pending: sum('pending'), billed: sum('billed'), collected: sum('collected'), seats: sum('seats') }, batches: rows };
}

module.exports = { createBatch, updateBatch, listBatches, roster, publicBatches, join, decide, leave, removeStudent, transfer, mine, childBatches, teaching, report, bill, billAll };
