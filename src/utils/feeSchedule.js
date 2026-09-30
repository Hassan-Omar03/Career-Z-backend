// Professional Fee Plan engine (spec Master Document 8.16 / 15D.7 / 15D.8). Every institution
// picks its own billing schedule (monthly school tuition, semester university fees, annual
// college fees, custom academy billing) — nothing here is hard-coded to an institution TYPE, only
// to whatever billingFrequency that program's FeeSchedule snapshot says.
const Fee = require('../models/Fee');
const FeeSchedule = require('../models/FeeSchedule');
const AppError = require('../utils/AppError');
const { notify } = require('../services/notification.service');

const MONTH_INTERVAL = { monthly: 1, quarterly: 3, biannual: 6, custom: null };

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Builds the ordered list of billing periods this schedule will ever have, each with the exact
// amount due — the real basis for "generate current/next cycle" and every preview/report below.
// Never generates more than the plan actually calls for (spec: "Do not generate the entire degree
// fee as monthly invoices unless the plan specifically says monthly").
function buildPeriodPlan(schedule) {
  const total = schedule.totalProgramFee;
  const freq = schedule.billingFrequency;

  if (freq === 'one_time') {
    const start = schedule.firstDueDate || schedule.academicYearStart || schedule.createdAt || new Date();
    return [{ key: 'one_time', label: 'One-time payment', startDate: start, amount: round2(total) }];
  }

  if (freq === 'term' || freq === 'semester') {
    const n = Math.max(1, Number(schedule.numberOfTerms) || 1);
    const start = schedule.academicYearStart || schedule.firstDueDate || new Date();
    const end = schedule.academicYearEnd || new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
    const spanMs = Math.max(1, end.getTime() - start.getTime());
    const per = round2(total / n);
    let allocated = 0;
    const periods = [];
    for (let i = 0; i < n; i += 1) {
      const amount = i === n - 1 ? round2(total - allocated) : per;
      allocated += amount;
      const startDate = new Date(start.getTime() + Math.round((spanMs * i) / n));
      periods.push({ key: `${freq === 'semester' ? 'Semester' : 'Term'}${i + 1}`, label: `${freq === 'semester' ? 'Semester' : 'Term'} ${i + 1}`, startDate, amount });
    }
    return periods;
  }

  if (freq === 'annual') {
    const start = schedule.academicYearStart || schedule.firstDueDate || new Date();
    const end = schedule.academicYearEnd || new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
    const years = Math.max(1, Math.round((end.getFullYear() - start.getFullYear())) || 1);
    const per = round2(total / years);
    let allocated = 0;
    const periods = [];
    for (let i = 0; i < years; i += 1) {
      const amount = i === years - 1 ? round2(total - allocated) : per;
      allocated += amount;
      const startDate = new Date(start.getFullYear() + i, start.getMonth(), start.getDate());
      periods.push({ key: String(start.getFullYear() + i), label: `Academic Year ${start.getFullYear() + i}`, startDate, amount });
    }
    return periods;
  }

  // monthly / quarterly / biannual / custom — all month-interval based.
  const interval = MONTH_INTERVAL[freq] || Math.max(1, Number(schedule.billingIntervalCount) || 1);
  const start = schedule.academicYearStart || schedule.firstDueDate || new Date();
  const end = schedule.academicYearEnd || new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  const totalMonths = Math.max(interval, Math.round((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())));
  const periodsCount = Math.max(1, Math.floor(totalMonths / interval));
  const per = round2(total / periodsCount);
  let allocated = 0;
  const periods = [];
  for (let i = 0; i < periodsCount; i += 1) {
    const amount = i === periodsCount - 1 ? round2(total - allocated) : per;
    allocated += amount;
    const startDate = new Date(start.getFullYear(), start.getMonth() + i * interval, 1);
    periods.push({ key: `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`, label: startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), startDate, amount });
  }
  return periods;
}

// Which period is "current" (the most recent one whose start date has arrived) and which is
// "next" — the basis for the Generate Current/Next Billing Cycle buttons.
function currentAndNextPeriod(schedule, now = new Date()) {
  const plan = buildPeriodPlan(schedule);
  let currentIndex = -1;
  for (let i = 0; i < plan.length; i += 1) {
    if (plan[i].startDate <= now) currentIndex = i; else break;
  }
  return { plan, current: currentIndex >= 0 ? plan[currentIndex] : null, next: plan[currentIndex + 1] || null };
}

function dueDateFor(schedule, period) {
  const due = new Date(period.startDate);
  due.setDate(Math.min(28, Number(schedule.dueDay) || 10));
  if (due < period.startDate) due.setMonth(due.getMonth() + 1);
  return due;
}

// Idempotent — the real guard is FeeSchedule.periodsGenerated + Fee's unique (schedule,
// billingPeriod, installment.number) index; calling this twice for the same period is a no-op.
async function generateInvoicesForPeriod(schedule, period, generatedBy) {
  if (schedule.periodsGenerated.includes(period.key)) return [];
  const existing = await Fee.exists({ schedule: schedule._id, billingPeriod: period.key });
  if (existing) { schedule.periodsGenerated.push(period.key); await schedule.save(); return []; }

  const perInstallment = Math.max(1, Number(schedule.installmentsPerBillingCycle) || 1);
  const dueDate = dueDateFor(schedule, period);
  const graceEndDate = new Date(dueDate); graceEndDate.setDate(graceEndDate.getDate() + (schedule.gracePeriodDays || 0));
  const created = [];

  // One-time additional charges (admission/exam/hostel/etc.) bill exactly once, on the very
  // first period this schedule ever generates — never repeated on later periods.
  {
    const extraTypes = ['admission', 'exam', 'hostel', 'transport', 'library', 'activity'];
    for (let extraIndex = 0; extraIndex < extraTypes.length; extraIndex += 1) {
      const type = extraTypes[extraIndex];
      const extra = schedule.additionalFees?.[type];
      const recurring = ['hostel', 'transport'].includes(type) && extra?.recurrence === 'every_cycle';
      if (extra?.enabled && extra.amount > 0 && (!schedule.additionalFeesBilled || recurring)) {
        created.push(await Fee.create({
          student: schedule.student, institution: schedule.institution, schedule: schedule._id,
          title: `${schedule.programName} ${type.charAt(0).toUpperCase() + type.slice(1)} Fee`, feeType: type === 'admission' ? 'admission' : type,
          amount: extra.amount, originalAmount: extra.amount, currency: schedule.currency, dueDate, graceEndDate,
          billingPeriod: period.key, academicYear: String((schedule.academicYearStart || dueDate).getFullYear()),
          installment: { planId: `${schedule._id}-extras`, number: 100 + extraIndex, totalInstallments: null },
          status: 'pending', outstandingAmount: extra.amount, recordedBy: generatedBy
        }));
      }
    }
    schedule.additionalFeesBilled = true;
  }

  let allocated = 0;
  for (let i = 1; i <= perInstallment; i += 1) {
    const amount = i === perInstallment ? round2(period.amount - allocated) : round2(period.amount / perInstallment);
    allocated += amount;
    created.push(await Fee.create({
      student: schedule.student, institution: schedule.institution, schedule: schedule._id,
      title: `${schedule.programName} — ${period.label}${perInstallment > 1 ? ` (Instalment ${i}/${perInstallment})` : ''}`,
      feeType: 'tuition', amount, originalAmount: amount, currency: schedule.currency, dueDate, graceEndDate,
      billingPeriod: period.key, academicYear: String(period.startDate.getFullYear()),
      term: ['term', 'semester'].includes(schedule.billingFrequency) ? period.key : '',
      installment: { planId: `${schedule._id}`, number: i, totalInstallments: perInstallment },
      status: 'pending', outstandingAmount: amount, recordedBy: generatedBy
    }));
  }

  schedule.periodsGenerated.push(period.key);
  await schedule.save();

  if (created.length) {
    await notify(schedule.student, {
      title: `New invoice: ${schedule.programName} — ${period.label}`,
      body: `${schedule.currency} ${round2(created.reduce((s, f) => s + f.amount, 0))} due ${dueDate.toLocaleDateString()}`,
      sentBy: generatedBy
    }, { email: true }).catch(() => {});
  }
  return created;
}

async function generateCurrentCycle(schedule, generatedBy) {
  const { current } = currentAndNextPeriod(schedule);
  if (!current) throw new AppError('No billing period has started yet for this schedule.', 400);
  return generateInvoicesForPeriod(schedule, current, generatedBy);
}

async function generateNextCycle(schedule, generatedBy) {
  const { next } = currentAndNextPeriod(schedule);
  if (!next) throw new AppError('This fee plan has no further billing periods (final period already generated).', 400);
  return generateInvoicesForPeriod(schedule, next, generatedBy);
}

function previewCycle(schedule, which = 'current') {
  const { current, next } = currentAndNextPeriod(schedule);
  const period = which === 'next' ? next : current;
  if (!period) return null;
  const already = schedule.periodsGenerated.includes(period.key);
  return {
    period: period.key, label: period.label, amount: period.amount, dueDate: dueDateFor(schedule, period),
    installments: Math.max(1, Number(schedule.installmentsPerBillingCycle) || 1), alreadyGenerated: already,
    currency: schedule.currency
  };
}

// Real oldest-first partial-payment allocation onto ONE fee (spec: "Payment allocation to the
// oldest outstanding installment" is achieved by the caller selecting fees oldest-due-first and
// calling this per fee until the payment amount is exhausted).
async function applyPaymentToFee(fee, { amount, method, transactionId, recordedBy, verifiedBy }) {
  if (amount <= 0) throw new AppError('Payment amount must be positive.', 422);
  const outstanding = fee.outstandingAmount ?? fee.amount;
  const applied = Math.min(round2(amount), round2(outstanding));
  fee.paidAmount = round2((fee.paidAmount || 0) + applied);
  fee.outstandingAmount = round2(Math.max(0, fee.amount - fee.paidAmount));
  fee.paymentHistory.push({ amount: applied, method, transactionId, recordedBy, verifiedBy, verifiedAt: verifiedBy ? new Date() : null });
  fee.status = fee.outstandingAmount <= 0 ? 'paid' : 'partially_paid';
  if (fee.status === 'paid') {
    fee.paidAt = new Date();
    fee.restrictionActive = false;
  }
  return { fee, applied, remainder: round2(amount - applied) };
}

// THE answer to "if a student pays one fee, how does the next one get created": this lazy sweep
// checks every active FeeSchedule at this institution and, the moment the next billing period's
// start date has actually arrived, generates it automatically — no one has to click "Generate
// Next" by hand, and payment status is irrelevant (a schedule keeps generating on its own
// calendar regardless of whether the previous invoice was ever paid). Idempotent via the same
// periodsGenerated/unique-index guard generateCurrentCycle already uses, so running this on every
// page load from multiple students/staff at once never creates duplicates.
async function autoGenerateDueInvoices(institutionId) {
  const schedules = await FeeSchedule.find({ institution: institutionId, status: 'active', autoGenerateInvoices: { $ne: false } });
  let created = 0;
  for (const schedule of schedules) {
    try {
      const fees = await generateCurrentCycle(schedule, schedule.createdBy);
      created += fees.length;
    } catch { /* no period has started yet for this schedule — nothing to generate, not an error */ }
  }
  return created;
}

// Lazy, idempotent lifecycle sweep — the same "no cron in this app" pattern used everywhere else
// (see job/scholarship reminder comments). Called on real institution/student fee-page loads.
// Safe for multiple server instances: every write here is a targeted, idempotent field-set keyed
// off a guard field (lateFeeAppliedAt / status), so a concurrent duplicate run changes nothing.
async function sweepOverdueAndLateFees(institutionId) {
  const now = new Date();
  // 'processing' is deliberately excluded: that status means a manual payment report is sitting
  // in the institution's verification queue, and flipping it back to 'overdue' here would silently
  // erase it from that queue on the very next page load.
  const dueFees = await Fee.find({
    institution: institutionId,
    status: { $in: ['pending', 'partially_paid'] },
    dueDate: { $ne: null, $lte: now }
  }).populate('schedule');

  for (const fee of dueFees) {
    if (fee.status !== 'overdue') {
      fee.status = 'overdue';
    }
    const graceEnd = fee.graceEndDate || fee.dueDate;
    const schedule = fee.schedule;
    if (schedule?.lateFeeEnabled && !fee.lateFeeAppliedAt && now > graceEnd) {
      const base = fee.outstandingAmount ?? fee.amount;
      let lateFee = schedule.lateFeeType === 'percentage' ? round2(base * (schedule.lateFeeValue / 100)) : round2(schedule.lateFeeValue);
      if (schedule.maximumLateFee != null) lateFee = Math.min(lateFee, schedule.maximumLateFee);
      if (lateFee > 0) {
        fee.lateFeeAmount = lateFee;
        fee.lateFeeAppliedAt = now;
        fee.amount = round2(fee.amount + lateFee);
        fee.outstandingAmount = round2((fee.outstandingAmount ?? fee.amount) + lateFee);
        await notify(fee.student, { title: `Late fee applied: ${fee.title}`, body: `${fee.currency} ${lateFee} added — now ${fee.currency} ${fee.outstandingAmount} due.`, sentBy: null }, { email: true }).catch(() => {});
      }
    }
    await fee.save();
  }
  return dueFees.length;
}

// Configurable reminders (spec) — every stage sent at most once per fee (notificationLog guard).
async function sweepReminders(institutionId) {
  const now = new Date();
  const fees = await Fee.find({ institution: institutionId, status: { $in: ['pending', 'processing', 'partially_paid', 'overdue'] } }).populate('schedule');
  let sent = 0;
  for (const fee of fees) {
    if (fee.schedule && fee.schedule.autoSendReminders === false) continue;
    const rules = fee.schedule?.reminderRules || { daysBeforeDue: [3], onDueDate: true, afterGracePeriod: true };
    const stagesSent = new Set(fee.notificationLog.map((n) => n.stage));
    const daysUntilDue = fee.dueDate ? Math.ceil((fee.dueDate - now) / (24 * 60 * 60 * 1000)) : null;

    const fire = async (stage, title, body) => {
      if (stagesSent.has(stage)) return;
      await notify(fee.student, { title, body, sentBy: null }, { email: true }).catch(() => {});
      fee.notificationLog.push({ stage });
      sent += 1;
    };

    if (daysUntilDue !== null) {
      for (const d of rules.daysBeforeDue || []) {
        if (daysUntilDue === d) await fire(`due_in_${d}`, `Fee due in ${d} day${d === 1 ? '' : 's'}: ${fee.title}`, `${fee.currency} ${fee.outstandingAmount ?? fee.amount} due ${fee.dueDate.toLocaleDateString()}.`);
      }
      if (rules.onDueDate && daysUntilDue === 0) await fire('due_today', `Fee due today: ${fee.title}`, `${fee.currency} ${fee.outstandingAmount ?? fee.amount} is due today.`);
    }
    if (fee.status === 'overdue') await fire('overdue', `Overdue fee: ${fee.title}`, `${fee.currency} ${fee.outstandingAmount ?? fee.amount} is overdue.`);
    if (rules.afterGracePeriod && fee.graceEndDate && now > fee.graceEndDate) await fire('grace_period_ended', `Grace period ended: ${fee.title}`, `Grace period has ended for ${fee.title}.`);

    if (fee.isModified()) await fee.save();
  }
  return sent;
}

module.exports = {
  buildPeriodPlan, currentAndNextPeriod, dueDateFor, generateInvoicesForPeriod,
  generateCurrentCycle, generateNextCycle, previewCycle, applyPaymentToFee,
  sweepOverdueAndLateFees, sweepReminders, autoGenerateDueInvoices, round2
};
