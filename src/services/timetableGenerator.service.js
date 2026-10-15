const ClassSection = require('../models/ClassSection');
const Course = require('../models/Course');
const TimetableEntry = require('../models/TimetableEntry');

// Automatic timetable for an institution's class sections. Inputs are the institution's real
// data: each section's courses with their assigned teacher (Course Academic Assignments), and
// periods per week from the course's credit hours unless the institution sets a number.
// Hard rules: a section never has two classes at once, a teacher never teaches two places at once
// (including timetables of sections that are not being regenerated), a teacher's unavailable
// days are respected. Soft rule: a course's periods are spread over different days.

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const overlaps = (a, b) => toMin(a.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(a.endTime);

function validateSettings(s = {}) {
  const days = (Array.isArray(s.days) && s.days.length ? s.days : ['mon', 'tue', 'wed', 'thu', 'fri']).filter((d) => DAYS.includes(d));
  const dayStart = /^\d{2}:\d{2}$/.test(s.dayStart || '') ? s.dayStart : '08:00';
  const periodMinutes = Math.round(Number(s.periodMinutes) || 45);
  const periodsPerDay = Math.round(Number(s.periodsPerDay) || 7);
  const breakAfter = s.breakAfter === '' || s.breakAfter == null ? 4 : Math.round(Number(s.breakAfter));
  const breakMinutes = Math.round(Number(s.breakMinutes ?? 30));
  const errors = [];
  if (!days.length) errors.push('Pick at least one teaching day.');
  if (periodMinutes < 15 || periodMinutes > 180) errors.push('A period must be 15 to 180 minutes.');
  if (periodsPerDay < 1 || periodsPerDay > 14) errors.push('Periods per day must be 1 to 14.');
  if (breakAfter < 0 || breakAfter > periodsPerDay) errors.push('"Break after period" must be between 0 and the number of periods.');
  if (breakMinutes < 0 || breakMinutes > 120) errors.push('The break must be 0 to 120 minutes.');
  const end = toMin(dayStart) + periodsPerDay * periodMinutes + (breakAfter > 0 && breakAfter < periodsPerDay ? breakMinutes : 0);
  if (end > 23 * 60 + 59) errors.push('The school day would run past midnight. Start earlier or use fewer periods.');
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { statusCode: 422 });
  return { days, dayStart, periodMinutes, periodsPerDay, breakAfter, breakMinutes };
}

// The day's period start/end times.
function periodTimes(cfg) {
  const out = [];
  let t = toMin(cfg.dayStart);
  for (let p = 1; p <= cfg.periodsPerDay; p += 1) {
    out.push({ period: p, startTime: toTime(t), endTime: toTime(t + cfg.periodMinutes) });
    t += cfg.periodMinutes;
    if (p === cfg.breakAfter && p < cfg.periodsPerDay) t += cfg.breakMinutes;
  }
  return out;
}

// Seeded shuffle so a retry explores a different order but results are reproducible.
function shuffle(list, seed) {
  const a = [...list];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i -= 1) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function loadDemand(institutionId, sectionIds, periodsPerCourse = {}) {
  const sectionFilter = { institution: institutionId, ...(sectionIds?.length ? { _id: { $in: sectionIds } } : {}) };
  const sections = await ClassSection.find(sectionFilter).select('name').sort({ name: 1 }).lean();
  const courses = await Course.find({ institution: institutionId, classSection: { $in: sections.map((s) => s._id) } })
    .select('title subject classSection teacher creditHours').populate('teacher', 'fullName').lean();
  const demand = [], skipped = [];
  for (const c of courses) {
    const section = sections.find((s) => String(s._id) === String(c.classSection));
    if (!c.teacher) { skipped.push({ section: section?.name, course: c.title, reason: 'No teacher is assigned to this course.' }); continue; }
    const requested = periodsPerCourse[String(c._id)];
    const periods = requested === undefined || requested === '' ? Math.max(1, Math.round(c.creditHours || 3)) : Math.round(Number(requested));
    if (!Number.isFinite(periods) || periods < 0 || periods > 30) throw Object.assign(new Error(`Periods per week for ${c.title} must be 0 to 30.`), { statusCode: 422 });
    if (periods === 0) continue;
    demand.push({ course: c, section, teacherId: String(c.teacher._id), periods });
  }
  return { sections, demand, skipped };
}

function solve(cfg, demand, busyTeacher, seed) {
  const times = periodTimes(cfg);
  const slots = cfg.days.flatMap((day) => times.map((t) => ({ day, ...t })));
  const sectionBusy = new Set();
  const teacherBusy = (teacherId, slot) => (busyTeacher.get(teacherId) || []).some((b) => b.day === slot.day && overlaps(b, slot));
  const placed = [], unplaced = [];
  // Hardest first: teachers with the heaviest weekly load, then courses with the most periods.
  const load = new Map();
  for (const d of demand) load.set(d.teacherId, (load.get(d.teacherId) || 0) + d.periods);
  const order = shuffle(demand, seed).sort((a, b) => (load.get(b.teacherId) - load.get(a.teacherId)) || (b.periods - a.periods));
  for (const d of order) {
    const perDay = new Map();
    for (let n = 0; n < d.periods; n += 1) {
      const maxPerDay = Math.ceil(d.periods / cfg.days.length);
      const candidates = shuffle(slots, seed + n + 7).filter((slot) => !sectionBusy.has(`${d.section._id}|${slot.day}|${slot.period}`) && !teacherBusy(d.teacherId, slot));
      // Prefer days this course has not used yet, then earlier periods.
      candidates.sort((a, b) => ((perDay.get(a.day) || 0) - (perDay.get(b.day) || 0)) || (a.period - b.period));
      const slot = candidates.find((c) => (perDay.get(c.day) || 0) < maxPerDay) || candidates[0];
      if (!slot) { unplaced.push({ section: d.section.name, course: d.course.title, teacher: d.course.teacher.fullName, missing: d.periods - n }); break; }
      sectionBusy.add(`${d.section._id}|${slot.day}|${slot.period}`);
      busyTeacher.set(d.teacherId, [...(busyTeacher.get(d.teacherId) || []), slot]);
      perDay.set(slot.day, (perDay.get(slot.day) || 0) + 1);
      placed.push({ classSection: d.section._id, sectionName: d.section.name, course: d.course._id, subject: d.course.title, teacher: d.course.teacher._id, teacherName: d.course.teacher.fullName, dayOfWeek: slot.day, period: slot.period, startTime: slot.startTime, endTime: slot.endTime });
    }
  }
  return { placed, unplaced };
}

// Builds the best timetable found in a few attempts. Does not save anything.
async function generate(institutionId, { sections: sectionIds, settings, periodsPerCourse, unavailable = {} } = {}) {
  const cfg = validateSettings(settings);
  const { sections, demand, skipped } = await loadDemand(institutionId, sectionIds, periodsPerCourse);
  if (!sections.length) throw Object.assign(new Error('Add a class section first.'), { statusCode: 422 });
  if (!demand.length) throw Object.assign(new Error('None of these sections has a course with a teacher yet. Link courses to sections and teachers in Course Academic Assignments first.'), { statusCode: 422 });
  const capacity = cfg.days.length * cfg.periodsPerDay;
  for (const s of sections) {
    const need = demand.filter((d) => String(d.section._id) === String(s._id)).reduce((n, d) => n + d.periods, 0);
    if (need > capacity) throw Object.assign(new Error(`${s.name} needs ${need} periods a week but the week has only ${capacity}. Add periods or days, or lower periods per course.`), { statusCode: 422 });
  }
  // Teachers' existing classes in sections that are NOT being regenerated stay fixed.
  const others = await TimetableEntry.find({ institution: institutionId, classSection: { $nin: sections.map((s) => s._id) }, teacher: { $in: [...new Set(demand.map((d) => d.teacherId))] } }).select('teacher dayOfWeek startTime endTime').lean();
  let best = null;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const busy = new Map();
    for (const e of others) { const k = String(e.teacher); busy.set(k, [...(busy.get(k) || []), { day: e.dayOfWeek, startTime: e.startTime, endTime: e.endTime }]); }
    // A teacher's days off block the whole day.
    for (const [teacherId, days] of Object.entries(unavailable || {})) for (const day of (days || []).filter((d) => DAYS.includes(d))) busy.set(teacherId, [...(busy.get(teacherId) || []), { day, startTime: '00:00', endTime: '23:59' }]);
    const result = solve(cfg, demand, busy, attempt * 17);
    const missing = result.unplaced.reduce((n, u) => n + u.missing, 0);
    if (!best || missing < best.missing) best = { ...result, missing };
    if (!missing) break;
  }
  const order = (e) => `${e.sectionName}|${cfg.days.indexOf(e.dayOfWeek)}|${String(e.period).padStart(2, '0')}`;
  return { settings: cfg, periods: periodTimes(cfg), entries: best.placed.sort((a, b) => order(a).localeCompare(order(b))), unplaced: best.unplaced, skipped, sections: sections.map((s) => ({ _id: s._id, name: s.name })) };
}

module.exports = { generate, validateSettings, periodTimes, DAYS };
