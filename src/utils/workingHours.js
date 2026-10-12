const AppError = require('./AppError');

const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// Weekday and minutes-since-midnight of `date` in the institution's own timezone.
function localTime(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAY[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Enforced only when the institution opted in for this activity (Institute Settings → working
// hours policy). `kind` is 'ptm' or 'liveClasses'. The whole slot must fit inside one school day.
async function assertWithinWorkingHours(institutionId, start, end, kind, label) {
  if (!institutionId) return;
  const settings = await require('../models/InstitutionSettings').findOne({ institution: institutionId }).lean();
  if (!settings?.workingHoursPolicy?.[kind]) return;
  const tz = settings.timezone || 'Asia/Karachi';
  const days = settings.workingDays?.length ? settings.workingDays : [1, 2, 3, 4, 5];
  const open = toMinutes(settings.schoolHours?.start || '08:00'), close = toMinutes(settings.schoolHours?.end || '14:00');
  const from = localTime(new Date(start), tz), to = localTime(new Date(end || start), tz);
  const sameDay = new Date(end || start) - new Date(start) < 24 * 3600000 && from.day === to.day;
  if (!days.includes(from.day) || !sameDay || from.minutes < open || to.minutes > close) {
    const dayList = days.slice().sort().map((d) => DAY_NAME[d]).join(', ');
    throw new AppError(`${label} must be within school working hours: ${dayList}, ${settings.schoolHours?.start || '08:00'}–${settings.schoolHours?.end || '14:00'} (${tz}).`, 422);
  }
}

module.exports = { assertWithinWorkingHours, localTime };
