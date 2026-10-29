const mongoose = require('mongoose');
const EmployerPayslip = require('../models/EmployerPayslip');
const Employment = require('../models/Employment');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('./notification.service');

const fail = (message, status = 422) => new AppError(message, status);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LINK = '/dashboard?tab=jobs&sub=payslips';

// The employer, or a company the user runs payroll for as staff (manage_payments).
async function employerFor(user, employerId) {
  if (employerId && String(employerId) !== String(user._id)) {
    await require('./employerStaff.service').assertPermission(user._id, employerId, 'manage_payments');
    return employerId;
  }
  if (!(await isRoleVerified(user._id, 'employer'))) throw fail('Only a verified employer can run payroll.', 403);
  return user._id;
}

function lines(list, label) {
  return [].concat(list || []).filter((l) => l && String(l.label || '').trim()).slice(0, 15).map((l) => {
    const amount = Number(l.amount);
    if (!Number.isFinite(amount) || amount < 0) throw fail(`Each ${label} needs an amount of 0 or more.`);
    return { label: String(l.label).trim().slice(0, 60), amount: round2(amount) };
  });
}
const day = (v, label) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < 0 || n > 31) throw fail(`${label} must be 0 to 31.`); return n; };

// Active employees and this month's payslips.
async function month(user, { employer: employerId, month: m } = {}) {
  const employer = await employerFor(user, employerId);
  const wanted = MONTH.test(m || '') ? m : new Date().toISOString().slice(0, 7);
  const [employees, slips] = await Promise.all([
    Employment.find({ employer, status: 'active' }).populate('employee', 'fullName email').populate('job', 'title').select('employee job salary currency startDate').lean(),
    EmployerPayslip.find({ employer, month: wanted }).populate('employee', 'fullName email').lean()
  ]);
  return { month: wanted, employees, payslips: slips, totals: { net: round2(slips.reduce((s, p) => s + p.net, 0)), paid: slips.filter((p) => p.status === 'paid').length } };
}

// Create or update a draft payslip.
async function save(user, body = {}) {
  const employer = await employerFor(user, body.employer);
  if (!MONTH.test(body.month || '')) throw fail('Choose the month (YYYY-MM).');
  if (!mongoose.isValidObjectId(body.employment)) throw fail('Choose the employee.');
  const employment = await Employment.findOne({ _id: body.employment, employer });
  if (!employment) throw fail('Employee not found.', 404);
  const basic = Number(body.basic ?? employment.salary);
  if (!Number.isFinite(basic) || basic < 0) throw fail('Enter the basic salary.');
  const allowances = lines(body.allowances, 'allowance');
  const deductions = lines(body.deductions, 'deduction');
  const bonus = round2(Number(body.bonus || 0));
  if (bonus < 0) throw fail('Bonus cannot be negative.');
  const workingDays = day(body.workingDays, 'Working days'), presentDays = day(body.presentDays, 'Present days'), leaveDays = day(body.leaveDays, 'Leave days'), absentDays = day(body.absentDays, 'Absent days');
  if (workingDays && presentDays + leaveDays + absentDays > workingDays) throw fail('Present, leave and absent days cannot add up to more than the working days.');
  const gross = round2(basic + bonus + allowances.reduce((s, l) => s + l.amount, 0));
  const net = round2(gross - deductions.reduce((s, l) => s + l.amount, 0));
  if (net < 0) throw fail('Deductions are more than the salary.');
  const existing = await EmployerPayslip.findOne({ employment: employment._id, month: body.month });
  if (existing && existing.status !== 'draft') throw fail('This payslip is already issued; it cannot be changed.', 409);
  const doc = existing || new EmployerPayslip({ employer, employment: employment._id, employee: employment.employee, month: body.month, createdBy: user._id });
  Object.assign(doc, { currency: employment.currency || 'PKR', basic: round2(basic), allowances, bonus, deductions, workingDays, presentDays, leaveDays, absentDays, gross, net, note: String(body.note || '').trim().slice(0, 500) });
  await doc.save();
  return doc;
}

async function own(user, id, employerId) {
  const employer = await employerFor(user, employerId);
  if (!mongoose.isValidObjectId(id)) throw fail('Payslip not found.', 404);
  const p = await EmployerPayslip.findOne({ _id: id, employer });
  if (!p) throw fail('Payslip not found.', 404);
  return p;
}

async function issue(user, id, employerId) {
  const p = await own(user, id, employerId);
  if (p.status !== 'draft') throw fail('This payslip is already issued.', 409);
  p.status = 'issued';
  p.issuedAt = new Date();
  await p.save();
  await notify(p.employee, { title: `Payslip for ${p.month}: ${p.currency} ${p.net.toLocaleString()}`, body: 'Open My Payslips to see the details.', link: LINK, category: 'payslip' }).catch(() => {});
  return p;
}

async function markPaid(user, id, { paidOn, reference, employer } = {}) {
  const p = await own(user, id, employer);
  if (p.status !== 'issued') throw fail(p.status === 'paid' ? 'Already marked paid.' : 'Issue the payslip first.', 409);
  const d = paidOn ? new Date(paidOn) : new Date();
  if (Number.isNaN(d.getTime()) || d > new Date(Date.now() + 864e5)) throw fail('Enter the date the salary was paid.');
  p.status = 'paid';
  p.paidOn = d;
  p.paymentRef = String(reference || '').trim().slice(0, 80);
  await p.save();
  await notify(p.employee, { title: `Salary for ${p.month} marked paid`, body: 'Please confirm in My Payslips whether you received it.', link: LINK, category: 'payslip' }).catch(() => {});
  return p;
}

async function remove(user, id, employerId) {
  const p = await own(user, id, employerId);
  if (p.status !== 'draft') throw fail('Only a draft payslip can be deleted.', 409);
  await p.deleteOne();
  return { deleted: true };
}

// Employee side.
async function mine(user) {
  return EmployerPayslip.find({ employee: user._id, status: { $in: ['issued', 'paid'] } }).populate('employer', 'fullName').sort({ month: -1 }).lean();
}
async function confirm(user, id, { received, note } = {}) {
  if (!mongoose.isValidObjectId(id)) throw fail('Payslip not found.', 404);
  const p = await EmployerPayslip.findOne({ _id: id, employee: user._id, status: 'paid' });
  if (!p) throw fail('Payslip not found.', 404);
  if (typeof received !== 'boolean') throw fail('Say whether you received the salary.');
  p.employeeConfirmation = { received, at: new Date(), note: String(note || '').trim().slice(0, 300) };
  await p.save();
  if (!received) await notify(p.employer, { title: `Salary for ${p.month} not received`, body: `${user.fullName} says the salary did not arrive. ${p.employeeConfirmation.note}`, category: 'payslip' }).catch(() => {});
  return p;
}

// For the trust score: confirmed salaries, on time = paid within 10 days after the month ends.
async function onTimeRecord(employerId) {
  const slips = await EmployerPayslip.find({ employer: employerId, status: 'paid', 'employeeConfirmation.received': { $ne: null } }).select('month paidOn employeeConfirmation').lean();
  return slips.map((s) => {
    const [y, m] = s.month.split('-').map(Number);
    const due = new Date(Date.UTC(y, m, 10, 23, 59));
    return s.employeeConfirmation.received === true && new Date(s.paidOn) <= due;
  });
}

module.exports = { month, save, issue, markPaid, remove, mine, confirm, onTimeRecord };
