// Professional Fee Management (spec 8.16 / 15D.7 / 15D.8) — the fee-PLAN, generation, discount,
// verification, defaulter, restriction and reporting layer on top of the existing Fee/
// InstitutionProgram/StudentInstitutionMembership records (institution.controller.js keeps the
// original createFee/listFees/refund endpoints working unchanged for backward compatibility).
const crypto = require('crypto');
const Institution = require('../models/Institution');
const InstitutionProgram = require('../models/InstitutionProgram');
const FeeSchedule = require('../models/FeeSchedule');
const Fee = require('../models/Fee');
const StudentProfile = require('../models/StudentProfile');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');
const feeSchedule = require('../utils/feeSchedule');

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const staffEntry = institution.staff.find((s) => s.user.toString() === userId.toString());
  if (!isOwner && !staffEntry) throw new AppError('You do not manage this institution.', 403);
  return { isOwner, staffEntry };
}

// Read-only finance access (any owner/staff) vs. mutation access (owner, or staff explicitly
// granted 'fee:manage') — spec: "Read-only finance permissions should not mutate."
function assertFeeManage(institution, userId) {
  const { isOwner, staffEntry } = assertOwnerOrStaff(institution, userId);
  if (!isOwner && !(staffEntry.permissions || []).includes('fee:manage')) {
    throw new AppError('You need the fee:manage permission to change fee records.', 403);
  }
}

function assertVerified(institution) {
  if (institution.verificationStatus !== 'approved') throw new AppError('This institution must be verified by Super Admin before it can do this.', 403);
}

async function loadInstitution(id) {
  const institution = await Institution.findById(id);
  if (!institution) throw new AppError('Institution not found.', 404);
  return institution;
}

// ---- Fee Plans (InstitutionProgram billing config) ----

// PATCH /api/institution-fees/:institutionId/programs/:programId/billing
const updateProgramBilling = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertFeeManage(institution, req.user._id);
  const program = await InstitutionProgram.findOne({ _id: req.params.programId, institution: institution._id });
  if (!program) throw new AppError('Program not found.', 404);

  const allowed = [
    'billingFrequency', 'billingIntervalCount', 'academicYearStart', 'academicYearEnd', 'firstDueDate',
    'invoiceGenerationDay', 'dueDay', 'gracePeriodDays', 'numberOfTerms', 'installmentsPerBillingCycle',
    'autoGenerateInvoices', 'autoSendReminders', 'lateFeeEnabled', 'lateFeeType', 'lateFeeValue',
    'maximumLateFee', 'minimumPartialPayment', 'accessRestrictionPolicy', 'reminderRules'
  ];
  allowed.forEach((f) => { if (req.body[f] !== undefined) program[f] = req.body[f]; });
  await program.save();
  return ok(res, program, 'Billing configuration saved.');
});

// GET /api/institution-fees/:institutionId/schedules — every student's agreed fee-plan snapshot.
const listSchedules = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const filter = { institution: institution._id };
  if (req.query.program) filter.program = req.query.program;
  if (req.query.student) filter.student = req.query.student;
  const schedules = await FeeSchedule.find(filter).populate('student', 'fullName email').populate('program', 'name').sort({ createdAt: -1 });
  return ok(res, schedules);
});

// ---- Generation ----

// GET /api/institution-fees/:institutionId/schedules/:scheduleId/preview?which=current|next
const previewGeneration = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const schedule = await FeeSchedule.findOne({ _id: req.params.scheduleId, institution: institution._id }).populate('student', 'fullName email');
  if (!schedule) throw new AppError('Fee schedule not found.', 404);
  const preview = feeSchedule.previewCycle(schedule, req.query.which === 'next' ? 'next' : 'current');
  return ok(res, { student: schedule.student, ...preview });
});

// POST /api/institution-fees/:institutionId/schedules/:scheduleId/generate  body:{which:'current'|'next'}
const generateForSchedule = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertFeeManage(institution, req.user._id);
  assertVerified(institution);
  const schedule = await FeeSchedule.findOne({ _id: req.params.scheduleId, institution: institution._id });
  if (!schedule) throw new AppError('Fee schedule not found.', 404);
  const fees = req.body.which === 'next' ? await feeSchedule.generateNextCycle(schedule, req.user._id) : await feeSchedule.generateCurrentCycle(schedule, req.user._id);
  return created(res, fees, fees.length ? `${fees.length} invoice(s) generated.` : 'Already generated — nothing new to create.');
});

// POST /api/institution-fees/:institutionId/generate-all  body:{which, programId?}
// "Generate Fees for All Eligible Students" — idempotent per schedule, so re-running is always safe.
const generateForAllEligible = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertFeeManage(institution, req.user._id);
  assertVerified(institution);
  const filter = { institution: institution._id, status: 'active' };
  if (req.body.programId) filter.program = req.body.programId;
  const schedules = await FeeSchedule.find(filter);
  let created_ = 0; let studentsBilled = 0;
  for (const schedule of schedules) {
    try {
      const fees = req.body.which === 'next' ? await feeSchedule.generateNextCycle(schedule, req.user._id) : await feeSchedule.generateCurrentCycle(schedule, req.user._id);
      if (fees.length) { created_ += fees.length; studentsBilled += 1; }
    } catch { /* a schedule with no current/next period yet is skipped, not fatal to the batch */ }
  }
  return created(res, { invoicesCreated: created_, studentsBilled, schedulesChecked: schedules.length }, 'Batch generation complete.');
});

// ---- Discounts / Concessions / Scholarships ----

// POST /api/institution-fees/fees/:feeId/discount
const addDiscount = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await loadInstitution(fee.institution);
  assertFeeManage(institution, req.user._id);
  if (fee.status === 'paid') throw new AppError('A fully paid invoice cannot be adjusted — process a refund instead.', 400);

  const { kind, reason, percent, amount, expiresAt } = req.body;
  if (!kind) throw new AppError('kind is required.', 422);
  const base = fee.originalAmount ?? fee.amount;
  // Any kind (merit_scholarship, sibling, custom, ...) can be percent- or amount-based — 'kind' is
  // the reason category, `percent` vs `amount` is just which one the institution filled in.
  const computedAmount = percent != null ? feeSchedule.round2(base * ((Number(percent) || 0) / 100)) : feeSchedule.round2(Number(amount) || 0);
  if (computedAmount <= 0) throw new AppError('The discount must reduce the fee by a positive amount.', 422);
  const outstandingBeforeDiscount = fee.outstandingAmount ?? fee.amount;
  if (computedAmount > outstandingBeforeDiscount) throw new AppError('A discount cannot exceed the current outstanding amount.', 422);

  if (fee.originalAmount == null) fee.originalAmount = fee.amount;
  fee.discounts.push({ kind, reason: reason || '', percent: percent ?? null, amount: computedAmount, approvedBy: req.user._id, expiresAt: expiresAt || null });
  fee.amount = feeSchedule.round2(fee.amount - computedAmount);
  fee.outstandingAmount = feeSchedule.round2(outstandingBeforeDiscount - computedAmount);
  if (fee.outstandingAmount <= 0) { fee.status = 'paid'; fee.paidAt = new Date(); }
  await fee.save();
  await notify(fee.student, { title: `A discount was applied to ${fee.title}`, body: `${fee.currency} ${computedAmount} off — new balance ${fee.currency} ${fee.outstandingAmount}.`, sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, fee, 'Discount applied.');
});

// ---- Manual payment reporting + verification (partial payments, oldest-first via feeId) ----

// POST /api/institution-fees/fees/:feeId/report-payment — student/authorized parent reports a
// manual payment with proof/reference; goes to 'processing' until the institution verifies it.
const reportManualPayment = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const isStudent = fee.student.toString() === req.user._id.toString();
  if (!isStudent) {
    const link = await ParentChildLink.findOne({ parent: req.user._id, student: fee.student, status: 'approved' });
    if (!link || link.permissions?.payFees === false) throw new AppError('You are not authorized to pay this fee.', 403);
  }
  if (['paid', 'cancelled', 'waived', 'refunded'].includes(fee.status)) throw new AppError(`This fee is already ${fee.status}.`, 400);

  const { amount, method, reference, proofUrl, bankName, paidOn, notes } = req.body;
  const allowedMethods = ['bank_transfer', 'mobile_wallet', 'cash', 'other'];
  if (!allowedMethods.includes(method)) throw new AppError('Choose a valid manual payment method.', 422);
  if (!String(reference || '').trim()) throw new AppError('Payment reference or receipt number is required.', 422);
  if (method !== 'cash' && !String(proofUrl || '').trim()) throw new AppError('Payment proof is required for this payment method.', 422);
  if (['bank_transfer', 'mobile_wallet'].includes(method) && !String(bankName || '').trim()) throw new AppError('Bank or wallet/provider name is required.', 422);
  if (fee.paymentHistory.some((p) => p.verificationStatus === 'pending' || (!p.verificationStatus && !p.verifiedAt && !p.rejectedAt))) {
    throw new AppError('A payment report is already awaiting institution verification.', 409);
  }
  const outstanding = fee.outstandingAmount ?? fee.amount;
  const payAmount = amount != null ? Number(amount) : outstanding;
  if (!(payAmount > 0) || payAmount > outstanding + 0.01) throw new AppError('Enter a valid amount, up to the outstanding balance.', 422);

  // Institution-defined minimum partial payment (spec item 4) — never applies to a payment that
  // clears the full remaining balance, however small that final instalment happens to be.
  if (payAmount < outstanding - 0.01) {
    const schedule = fee.schedule ? await FeeSchedule.findById(fee.schedule).select('minimumPartialPayment') : null;
    const minimum = schedule?.minimumPartialPayment || 0;
    if (minimum > 0 && payAmount < minimum) {
      throw new AppError(`The minimum partial payment for this fee is ${fee.currency} ${minimum}.`, 422);
    }
  }

  const previousFeeStatus = fee.status;
  fee.paymentHistory.push({
    amount: feeSchedule.round2(payAmount), method, transactionId: String(reference).trim(), reference: String(reference).trim(),
    proofUrl: String(proofUrl || '').trim(), bankName: String(bankName || '').trim(), paidOn: paidOn || new Date(),
    notes: String(notes || '').trim(), verificationStatus: 'pending', previousFeeStatus, recordedBy: req.user._id
  });
  fee.status = 'processing';
  fee.paymentMethod = method;
  fee.paidBy = req.user._id;
  await fee.save();

  const institution = await Institution.findById(fee.institution);
  if (institution) {
    await notify(institution.owner, { title: `Payment reported: ${fee.title}`, body: `${fee.currency} ${payAmount} — awaiting your verification.`, sentBy: req.user._id }).catch(() => {});
  }
  return ok(res, fee, 'Payment reported — awaiting institution verification.');
});

// PATCH /api/institution-fees/fees/:feeId/verify-payment  body:{decision:'verify'|'reject', paymentIndex}
// Only institution verification actually moves money — never the client's self-report alone.
const verifyManualPayment = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertFeeManage(institution, req.user._id);

  const { decision, rejectionReason } = req.body;
  const pending = [...fee.paymentHistory].reverse().find((p) => p.verificationStatus === 'pending' || (!p.verificationStatus && !p.verifiedAt && !p.rejectedAt));
  if (!pending) throw new AppError('No unverified payment found on this fee.', 400);

  if (decision === 'reject') {
    if (!String(rejectionReason || '').trim()) throw new AppError('A rejection reason is required.', 422);
    pending.verificationStatus = 'rejected';
    pending.rejectedBy = req.user._id;
    pending.rejectedAt = new Date();
    pending.rejectionReason = String(rejectionReason).trim();
    const fallbackStatus = fee.outstandingAmount != null && fee.outstandingAmount < fee.amount ? 'partially_paid' : (fee.dueDate && new Date(fee.dueDate) < new Date() ? 'overdue' : 'pending');
    fee.status = pending.previousFeeStatus && pending.previousFeeStatus !== 'processing' ? pending.previousFeeStatus : fallbackStatus;
    await fee.save();
    await notify(fee.student, { title: `Payment rejected: ${fee.title}`, body: 'Your reported payment could not be verified. Please try again or contact the institution.', sentBy: req.user._id }, { email: true }).catch(() => {});
    return ok(res, fee, 'Payment rejected.');
  }
  if (decision !== 'verify') throw new AppError('decision must be verify or reject.', 422);

  pending.verifiedBy = req.user._id;
  pending.verifiedAt = new Date();
  pending.verificationStatus = 'verified';
  pending.receiptNumber = `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  pending.verifyCode = crypto.randomBytes(10).toString('hex');
  // The payment is already recorded in history from reportManualPayment — verifying it just
  // recomputes paid/outstanding totals from every verified entry (never double-applies).
  const verifiedTotal = fee.paymentHistory.filter((p) => p.verificationStatus === 'verified' || p.verifiedAt).reduce((sum, p) => sum + p.amount, 0);
  fee.paidAmount = feeSchedule.round2(verifiedTotal);
  fee.outstandingAmount = feeSchedule.round2(Math.max(0, fee.amount - fee.paidAmount));
  fee.status = fee.outstandingAmount <= 0 ? 'paid' : 'partially_paid';
  if (fee.status === 'paid') {
    fee.paidAt = new Date();
    fee.restrictionActive = false;
    if (!fee.receiptNumber) fee.receiptNumber = `RCPT-${Date.now().toString(36).toUpperCase()}-${fee.id.slice(-6).toUpperCase()}`;
    if (!fee.verifyCode) fee.verifyCode = crypto.randomBytes(10).toString('hex');
    fee.escrowStatus = fee.escrowStatus === 'none' ? 'held' : fee.escrowStatus;
  }
  await fee.save();
  await notify(fee.student, { title: `Payment verified: ${fee.title}`, body: `${fee.currency} ${pending.amount} confirmed. ${fee.status === 'paid' ? 'Fully paid.' : `Remaining: ${fee.currency} ${fee.outstandingAmount}`}`, sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, fee, 'Payment verified.');
});

// GET /api/institution-fees/:institutionId/payments-awaiting-verification
const listAwaitingVerification = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  // Matched on the pending paymentHistory entry itself, not just status==='processing' — a fee
  // whose status drifted back to overdue/pending some other way (e.g. an older data bug) must
  // still surface here as long as a payment report is genuinely unverified.
  const fees = await Fee.find({
    institution: institution._id,
    paymentHistory: { $elemMatch: { verificationStatus: 'pending' } }
  }).populate('student', 'fullName email').sort({ updatedAt: 1 });
  return ok(res, fees);
});

// ---- Defaulters / restriction lifecycle ----

// GET /api/institution-fees/:institutionId/defaulters — also runs the lazy overdue/late-fee sweep.
const listDefaulters = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  await feeSchedule.sweepOverdueAndLateFees(institution._id).catch(() => {});
  const fees = await Fee.find({ institution: institution._id, status: 'overdue' }).populate('student', 'fullName email').sort({ dueDate: 1 });
  return ok(res, fees);
});

// PATCH /api/institution-fees/fees/:feeId/waive — institution waives an outstanding fee.
const waiveFee = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  assertFeeManage(institution, req.user._id);
  if (fee.status === 'paid') throw new AppError('A fully paid fee cannot be waived.', 400);
  const waivedAmount = fee.outstandingAmount ?? fee.amount;
  fee.status = 'waived';
  fee.outstandingAmount = 0;
  fee.restrictionActive = false;
  fee.discounts.push({ kind: 'waiver', reason: req.body.reason || 'Waived by institution', amount: waivedAmount, approvedBy: req.user._id });
  await fee.save();
  await notify(fee.student, { title: `Fee waived: ${fee.title}`, body: req.body.reason || '', sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, fee, 'Fee waived.');
});

const cancelInvoice = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  assertFeeManage(institution, req.user._id);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new AppError('A cancellation reason is required.', 422);
  if (fee.status === 'processing') throw new AppError('Reject the pending payment proof before cancelling this invoice.', 400);
  if (Number(fee.paidAmount || 0) > 0 || ['partially_paid', 'paid', 'refunded'].includes(fee.status)) {
    throw new AppError('An invoice with payment history cannot be cancelled. Use the refund workflow.', 400);
  }
  if (['waived', 'cancelled'].includes(fee.status)) throw new AppError(`This invoice is already ${fee.status}.`, 400);
  fee.status = 'cancelled';
  fee.outstandingAmount = 0;
  fee.restrictionActive = false;
  fee.cancellation = { reason, cancelledAt: new Date(), cancelledBy: req.user._id };
  await fee.save();
  await notify(fee.student, { title: `Fee invoice cancelled: ${fee.title}`, body: reason, sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, fee, 'Invoice cancelled.');
});

// PATCH /api/institution-fees/fees/:feeId/payment-arrangement
const setPaymentArrangement = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  assertFeeManage(institution, req.user._id);
  const { revisedDueDate, installments, reason } = req.body;
  if (Array.isArray(installments)) {
    const invalid = installments.some((item) => !(Number(item.amount) > 0) || Number.isNaN(new Date(item.dueDate).getTime()));
    if (invalid) throw new AppError('Every agreed installment needs a positive amount and valid due date.', 422);
    const total = installments.reduce((sum, item) => sum + Number(item.amount), 0);
    if (total > (fee.outstandingAmount ?? fee.amount)) throw new AppError('Arrangement installments cannot exceed the outstanding balance.', 422);
  }
  fee.paymentArrangement = { revisedDueDate: revisedDueDate || null, installments: installments || [], approvedBy: req.user._id, reason: reason || '', status: 'active' };
  if (revisedDueDate) { fee.dueDate = new Date(revisedDueDate); fee.status = fee.outstandingAmount > 0 && fee.outstandingAmount < fee.amount ? 'partially_paid' : 'pending'; fee.restrictionActive = false; }
  await fee.save();
  await notify(fee.student, { title: `Payment arrangement agreed: ${fee.title}`, body: reason || '', sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, fee, 'Payment arrangement recorded.');
});

// GET /api/institution-fees/me/restriction?institutionId= — what a student is currently blocked
// from, at this one institution (spec: restrictions never touch another institution's access).
const getMyRestriction = asyncHandler(async (req, res) => {
  const { institutionId } = req.query;
  if (!institutionId) throw new AppError('institutionId is required.', 422);
  const blockingFee = await Fee.findOne({ student: req.user._id, institution: institutionId, status: 'overdue' }).populate('schedule').sort({ dueDate: 1 });
  if (!blockingFee) return ok(res, { restricted: false, policy: 'none' });
  const policy = blockingFee.schedule?.accessRestrictionPolicy || 'block_all';
  return ok(res, { restricted: policy !== 'none', policy, fee: { title: blockingFee.title, outstandingAmount: blockingFee.outstandingAmount ?? blockingFee.amount, currency: blockingFee.currency } });
});

// ---- Reports ----

// GET /api/institution-fees/:institutionId/reports/overview
const getOverview = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id });
  const sum = (list) => list.reduce((s, f) => s + f.amount, 0);
  const expected = sum(fees);
  const collected = fees.reduce((s, f) => s + (f.paidAmount || (f.status === 'paid' ? f.amount : 0)), 0);
  const outstanding = fees.filter((f) => !['paid', 'cancelled', 'waived', 'refunded'].includes(f.status)).reduce((s, f) => s + (f.outstandingAmount ?? f.amount), 0);
  const overdue = fees.filter((f) => f.status === 'overdue').length;
  const processing = fees.filter((f) => f.status === 'processing').length;
  const refunded = fees.filter((f) => f.status === 'refunded').reduce((s, f) => s + f.amount, 0);
  const defaulterIds = new Set(fees.filter((f) => f.status === 'overdue').map((f) => f.student.toString()));
  return ok(res, {
    expectedCollection: feeSchedule.round2(expected), collected: feeSchedule.round2(collected), outstanding: feeSchedule.round2(outstanding),
    overdueCount: overdue, processingCount: processing, refunded: feeSchedule.round2(refunded),
    collectionRate: expected > 0 ? Math.round((collected / expected) * 100) : 0, defaulterCount: defaulterIds.size
  });
});

// GET /api/institution-fees/:institutionId/reports/aging — outstanding aging buckets.
const getAgingReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const now = Date.now();
  const fees = await Fee.find({ institution: institution._id, status: { $in: ['pending', 'processing', 'partially_paid', 'overdue'] }, dueDate: { $ne: null } }).populate('student', 'fullName email');
  const buckets = { '1-30': [], '31-60': [], '61-90': [], '90+': [] };
  for (const fee of fees) {
    const days = Math.floor((now - fee.dueDate.getTime()) / (24 * 60 * 60 * 1000));
    if (days < 1) continue;
    const key = days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    buckets[key].push({ student: fee.student, title: fee.title, amount: fee.outstandingAmount ?? fee.amount, currency: fee.currency, daysOverdue: days });
  }
  return ok(res, buckets);
});

// GET /api/institution-fees/:institutionId/reports/ledger?studentId=
const getStudentLedger = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  if (!req.query.studentId) throw new AppError('studentId is required.', 422);
  const fees = await Fee.find({ institution: institution._id, student: req.query.studentId }).sort({ createdAt: 1 });
  return ok(res, fees);
});

// GET /api/institution-fees/:institutionId/reports/class-wise
const getClassWiseReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id }).populate('schedule', 'classSection');
  const StudentProfileModel = require('../models/StudentProfile');
  const profiles = await StudentProfileModel.find({ user: { $in: fees.map((f) => f.student) } }).select('user classSection');
  const classByStudent = new Map(profiles.map((p) => [p.user.toString(), p.classSection?.toString() || 'unassigned']));
  const rows = new Map();
  for (const fee of fees) {
    const key = fee.schedule?.classSection?.toString() || classByStudent.get(fee.student.toString()) || 'unassigned';
    if (!rows.has(key)) rows.set(key, { classSection: key, expected: 0, collected: 0, outstanding: 0, count: 0 });
    const row = rows.get(key);
    row.expected += fee.amount; row.collected += fee.paidAmount || (fee.status === 'paid' ? fee.amount : 0);
    row.outstanding += fee.status === 'paid' || fee.status === 'cancelled' || fee.status === 'waived' ? 0 : (fee.outstandingAmount ?? fee.amount);
    row.count += 1;
  }
  return ok(res, Array.from(rows.values()).map((r) => ({ ...r, expected: feeSchedule.round2(r.expected), collected: feeSchedule.round2(r.collected), outstanding: feeSchedule.round2(r.outstanding) })));
});

// GET /api/institution-fees/:institutionId/reports/program-wise
const getProgramWiseReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const schedules = await FeeSchedule.find({ institution: institution._id }).populate('program', 'name');
  const scheduleToProgram = new Map(schedules.map((s) => [s._id.toString(), s.program?.name || s.programName]));
  const fees = await Fee.find({ institution: institution._id, schedule: { $ne: null } });
  const rows = new Map();
  for (const fee of fees) {
    const key = scheduleToProgram.get(fee.schedule.toString()) || 'Unknown Program';
    if (!rows.has(key)) rows.set(key, { program: key, expected: 0, collected: 0, outstanding: 0 });
    const row = rows.get(key);
    row.expected += fee.amount; row.collected += fee.paidAmount || (fee.status === 'paid' ? fee.amount : 0);
    row.outstanding += ['paid', 'cancelled', 'waived'].includes(fee.status) ? 0 : (fee.outstandingAmount ?? fee.amount);
  }
  return ok(res, Array.from(rows.values()).map((r) => ({ ...r, expected: feeSchedule.round2(r.expected), collected: feeSchedule.round2(r.collected), outstanding: feeSchedule.round2(r.outstanding) })));
});

// GET /api/institution-fees/:institutionId/reports/fee-type
const getFeeTypeReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id });
  const rows = {};
  for (const fee of fees) {
    const key = fee.feeType || 'other';
    rows[key] = rows[key] || { feeType: key, expected: 0, collected: 0, count: 0 };
    rows[key].expected += fee.amount; rows[key].collected += fee.paidAmount || (fee.status === 'paid' ? fee.amount : 0); rows[key].count += 1;
  }
  return ok(res, Object.values(rows).map((r) => ({ ...r, expected: feeSchedule.round2(r.expected), collected: feeSchedule.round2(r.collected) })));
});

// GET /api/institution-fees/:institutionId/reports/payment-method
const getPaymentMethodReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id, $or: [{ 'paymentHistory.0': { $exists: true } }, { paymentMethod: { $ne: '' } }] });
  const rows = {};
  for (const fee of fees) {
    if (fee.paymentHistory?.length) {
      for (const p of fee.paymentHistory.filter((p) => p.verifiedAt || !fee.schedule)) {
        const key = p.method || 'unspecified';
        rows[key] = rows[key] || { method: key, totalCollected: 0, count: 0 };
        rows[key].totalCollected += p.amount; rows[key].count += 1;
      }
    } else if (fee.status === 'paid' && fee.paymentMethod) {
      const key = fee.paymentMethod;
      rows[key] = rows[key] || { method: key, totalCollected: 0, count: 0 };
      rows[key].totalCollected += fee.amount; rows[key].count += 1;
    }
  }
  return ok(res, Object.values(rows).map((r) => ({ ...r, totalCollected: feeSchedule.round2(r.totalCollected) })));
});

// GET /api/institution-fees/:institutionId/reports/discounts
const getDiscountReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id, 'discounts.0': { $exists: true } }).populate('student', 'fullName email').populate('discounts.approvedBy', 'fullName');
  const rows = fees.flatMap((fee) => fee.discounts.map((d) => ({
    student: fee.student, feeTitle: fee.title, kind: d.kind, reason: d.reason, amount: d.amount,
    approvedBy: d.approvedBy?.fullName, approvedAt: d.approvedAt, currency: fee.currency
  })));
  return ok(res, rows);
});

// GET /api/institution-fees/:institutionId/reports/refunds
const getRefundReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const fees = await Fee.find({ institution: institution._id, 'refund.status': { $ne: 'none' } }).populate('student', 'fullName email');
  return ok(res, fees.map((f) => ({ student: f.student, title: f.title, currency: f.currency, refund: f.refund })));
});

// GET /api/institution-fees/:institutionId/reports/collection?groupBy=day|month|year
const getCollectionReport = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const groupBy = ['day', 'month', 'year'].includes(req.query.groupBy) ? req.query.groupBy : 'month';
  const fees = await Fee.find({ institution: institution._id, status: 'paid', paidAt: { $ne: null } });
  const rows = {};
  for (const fee of fees) {
    const d = fee.paidAt;
    const key = groupBy === 'day' ? d.toISOString().slice(0, 10) : groupBy === 'year' ? String(d.getFullYear()) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    rows[key] = rows[key] || { period: key, collected: 0, count: 0 };
    rows[key].collected += fee.amount; rows[key].count += 1;
  }
  return ok(res, Object.values(rows).sort((a, b) => a.period.localeCompare(b.period)).map((r) => ({ ...r, collected: feeSchedule.round2(r.collected) })));
});

// GET /api/institution-fees/:institutionId/invoices — filterable list (spec item 9 filters), with
// full student identity attached (never just a bare User ID).
const listInvoicesFiltered = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  assertOwnerOrStaff(institution, req.user._id);
  const filter = { institution: institution._id };
  if (req.query.student) filter.student = req.query.student;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.feeType) filter.feeType = req.query.feeType;
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;
  if (req.query.term) filter.term = req.query.term;
  if (req.query.program) {
    const scheduleIds = await FeeSchedule.find({ institution: institution._id, program: req.query.program }).distinct('_id');
    filter.schedule = { $in: scheduleIds };
  }
  if (req.query.from || req.query.to) {
    filter.dueDate = {};
    if (req.query.from) filter.dueDate.$gte = new Date(req.query.from);
    if (req.query.to) filter.dueDate.$lte = new Date(req.query.to);
  }
  const fees = await Fee.find(filter).populate('student', 'fullName email').sort({ createdAt: -1 }).limit(500);
  const StudentProfileModel = require('../models/StudentProfile');
  const profiles = await StudentProfileModel.find({ user: { $in: fees.map((f) => f.student?._id).filter(Boolean) } }).select('user idCardCode rollNumber program classSection');
  const profileByStudent = new Map(profiles.map((p) => [p.user.toString(), p]));
  const enriched = fees.map((fee) => {
    const obj = fee.toObject();
    const profile = fee.student ? profileByStudent.get(fee.student._id.toString()) : null;
    obj.studentIdentity = profile ? { studentId: profile.idCardCode, rollNumber: profile.rollNumber, program: profile.program, classSection: profile.classSection } : null;
    return obj;
  });
  return ok(res, enriched);
});

// ---- Receipt/Invoice QR verification (public — same pattern as Certificate.verifyCode) ----

// GET /api/institution-fees/receipts/verify/:code — never exposes platform commission internals.
const verifyReceipt = asyncHandler(async (req, res) => {
  const fee = await Fee.findOne({ verifyCode: req.params.code }).populate('student', 'fullName').populate('institution', 'name');
  if (!fee) throw new AppError('Receipt not found.', 404);
  const verifiedPayment = [...(fee.paymentHistory || [])].reverse().find((p) => p.verificationStatus === 'verified' || p.verifiedAt);
  return ok(res, {
    valid: true, receiptNumber: fee.receiptNumber, student: fee.student?.fullName, institution: fee.institution?.name,
    title: fee.title, amountPaid: fee.paidAmount || fee.amount, currency: fee.currency, paidAt: fee.paidAt, status: fee.status,
    paymentMethod: verifiedPayment?.method || fee.paidVia || fee.paymentMethod || '',
    transactionReference: verifiedPayment?.reference || verifiedPayment?.transactionId || fee.transactionId || ''
  });
});

module.exports = {
  updateProgramBilling, listSchedules, previewGeneration, generateForSchedule, generateForAllEligible,
  addDiscount, reportManualPayment, verifyManualPayment, listAwaitingVerification,
  listDefaulters, waiveFee, cancelInvoice, setPaymentArrangement, getMyRestriction,
  getOverview, getAgingReport, getStudentLedger, verifyReceipt,
  getClassWiseReport, getProgramWiseReport, getFeeTypeReport, getPaymentMethodReport,
  getDiscountReport, getRefundReport, getCollectionReport, listInvoicesFiltered
};
