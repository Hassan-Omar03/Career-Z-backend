require('dotenv').config();

const mongoose = require('mongoose');
const crypto = require('crypto');
const connectDB = require('../config/db');
const User = require('../models/User');
const Institution = require('../models/Institution');
const InstitutionProgram = require('../models/InstitutionProgram');
const InstitutionApplication = require('../models/InstitutionApplication');
const StudentProfile = require('../models/StudentProfile');
const FeeSchedule = require('../models/FeeSchedule');
const TeacherEmployment = require('../models/TeacherEmployment');
const HostelRoom = require('../models/HostelRoom');
const Fee = require('../models/Fee');
const PayoutProfile = require('../models/PayoutProfile');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

const STUDENT_EMAIL = 'baitcvs@gmail.com';
const INSTITUTION_SLUG = 'gcuf';
const PROGRAM_NAME = 'BS Computer Science';

async function run() {
  await connectDB();

  const [student, institution] = await Promise.all([
    User.findOne({ email: STUDENT_EMAIL }),
    Institution.findOne({ slug: INSTITUTION_SLUG })
  ]);
  if (!student) throw new Error(`Student ${STUDENT_EMAIL} does not exist. Run the main seed once first.`);
  if (!institution) throw new Error(`Institution ${INSTITUTION_SLUG} does not exist. Run the main seed once first.`);
  if (institution.type === 'online_institute') throw new Error('Hostel cannot be enabled for an online institution.');

  const institutionWallet = await Wallet.findOneAndUpdate(
    { user: institution.owner, currency: 'PKR' },
    { $setOnInsert: { available: 0, pending: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const targetBalance = 1000000;
  const seedCredit = Math.max(0, targetBalance - Number(institutionWallet.available || 0));
  if (seedCredit > 0) {
    await Wallet.updateOne({ _id: institutionWallet._id }, { $inc: { available: seedCredit } });
    await WalletTransaction.create({ user: institution.owner, type: 'topup', amount: seedCredit, currency: 'PKR', status: 'completed', note: 'GCUF payroll QA seed balance', processedAt: new Date() });
  }

  const [program, profile] = await Promise.all([
    InstitutionProgram.findOne({ institution: institution._id, name: PROGRAM_NAME }),
    StudentProfile.findOne({ user: student._id })
  ]);
  if (!program || !profile) throw new Error('Mohammad academic seed is incomplete. Run the main seed once first.');

  const hostel = {
    enabled: true,
    amount: 12000,
    securityDeposit: 15000,
    messAvailable: true,
    messEnabled: true,
    messMonthlyAmount: 8000,
    recurrence: 'every_cycle'
  };
  program.additionalFees.hostel = { ...hostel, messEnabled: undefined };
  await program.save();

  await InstitutionApplication.findOneAndUpdate(
    { institution: institution._id, applicant: student._id, program: PROGRAM_NAME },
    {
      $set: {
        requestedServices: { hostel: true, mess: true, transport: false },
        feePlanSnapshot: {
          department: program.department,
          durationTerms: program.durationTerms,
          admissionFee: program.admissionFee,
          totalTuitionFee: program.totalTuitionFee,
          installments: program.installments,
          currency: program.currency,
          additionalFees: {
            exam: program.additionalFees.exam,
            hostel,
            transport: { enabled: false, amount: 0 },
            library: program.additionalFees.library,
            activity: program.additionalFees.activity
          },
          capturedAt: new Date()
        },
        status: 'accepted',
        source: 'self',
        submittedAt: new Date('2026-09-01T00:00:00+05:00'),
        reviewedBy: institution.owner,
        generatedStudentProfile: profile._id,
        notes: 'QA admission: hostel with mess requested and accepted.'
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const schedule = await FeeSchedule.findOneAndUpdate(
    { institution: institution._id, student: student._id, program: program._id },
    { $set: { 'additionalFees.hostel': hostel } },
    { new: true }
  );
  if (!schedule) throw new Error('Mohammad fee schedule is missing.');

  const now = new Date();
  const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const initialHostelAmount = hostel.amount + hostel.messMonthlyAmount + hostel.securityDeposit;
  const dueDate = new Date(now.getFullYear(), now.getMonth(), 10);
  if (dueDate < now) dueDate.setMonth(dueDate.getMonth() + 1);
  const hostelVoucher = await Fee.findOneAndUpdate(
    { institution: institution._id, student: student._id, feeType: 'hostel', billingPeriod },
    {
      $setOnInsert: {
        schedule: schedule._id,
        title: `${PROGRAM_NAME} Hostel Admission Package (Room + Mess + Security)`,
        amount: initialHostelAmount,
        originalAmount: initialHostelAmount,
        currency: program.currency,
        dueDate,
        academicYear: String(now.getFullYear()),
        installment: { planId: `${schedule._id}-hostel`, number: 102, totalInstallments: null },
        status: 'pending',
        outstandingAmount: initialHostelAmount,
        recordedBy: institution.owner
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!['paid', 'refunded'].includes(hostelVoucher.status)) {
    const transactionId = `SEED-HOSTEL-ADMISSION-${hostelVoucher._id}`;
    hostelVoucher.status = 'paid';
    hostelVoucher.paidAmount = initialHostelAmount;
    hostelVoucher.outstandingAmount = 0;
    hostelVoucher.paidAt = new Date('2026-09-01T00:00:00+05:00');
    hostelVoucher.paidVia = 'Admission counter';
    hostelVoucher.paymentMethod = 'cash';
    hostelVoucher.transactionId = transactionId;
    hostelVoucher.paidBy = student._id;
    hostelVoucher.receiptNumber ||= `RCPT-HOSTEL-${String(hostelVoucher._id).slice(-8).toUpperCase()}`;
    hostelVoucher.verifyCode ||= crypto.createHash('sha256').update(transactionId).digest('hex').slice(0, 20);
    if (!hostelVoucher.paymentHistory.some((payment) => payment.transactionId === transactionId)) {
      hostelVoucher.paymentHistory.push({
        amount: initialHostelAmount,
        method: 'cash',
        transactionId,
        recordedBy: institution.owner,
        verifiedBy: institution.owner,
        verifiedAt: hostelVoucher.paidAt,
        verificationStatus: 'verified',
        paidOn: hostelVoucher.paidAt,
        paidAt: hostelVoucher.paidAt,
        receiptNumber: hostelVoucher.receiptNumber,
        verifyCode: hostelVoucher.verifyCode,
        notes: 'Paid with hostel admission: first month room, mess and refundable security.'
      });
    }
    await hostelVoucher.save();
  }

  let warden = await User.findOne({ email: 'hostel.warden@careerz.local' });
  if (!warden) {
    warden = await User.create({
      fullName: 'GCUF Hostel Warden',
      email: 'hostel.warden@careerz.local',
      passwordHash: await User.hashPassword('CareerZ@123'),
      roles: ['institution_staff'],
      emailVerified: true,
      country: 'PK',
      language: 'en',
      currency: 'PKR'
    });
  }
  warden.fullName = 'Abdul Rehman';
  warden.phone = '+923001234567';
  warden.country = 'PK';
  warden.language = 'en';
  warden.currency = 'PKR';
  warden.emailVerified = true;
  warden.phoneVerified = true;
  warden.status = 'active';
  warden.companyName = 'GCUF Hostel Administration';
  warden.passwordHash = await User.hashPassword('CareerZ@123');
  warden.roles = [...new Set([...(warden.roles || []), 'institution_staff'])];
  await warden.save();
  await PayoutProfile.findOneAndUpdate(
    { user: warden._id },
    { $set: { preferredMethod: 'bank_transfer', bank: { accountTitle: 'Abdul Rehman', bankName: 'Meezan Bank', iban: 'PK00MEZN0000001234567890', accountNumber: '0123456789' }, mobileWallet: { provider: 'Easypaisa', accountTitle: 'Abdul Rehman', number: '03001234567' }, crypto: { asset: 'USDT', network: 'TRC20', address: 'TQaWardenQAAddress123456789' } } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await TeacherEmployment.findOneAndUpdate(
    { teacher: warden._id, institution: institution._id, status: 'active' },
    { $set: { role: 'warden', designation: 'Senior Hostel Warden', department: 'Student Affairs & Hostel Administration', contractTerms: 'Full-time residential hostel warden. Responsible for resident welfare, attendance, visitor and leave approvals, room discipline, incident escalation and emergency coordination. Shift: 4 PM to 8 AM; weekly off: Friday.', salaryType: 'monthly', monthlySalary: 45000, salaryCurrency: 'PKR', taxPercent: 0, commissionPercent: 0, offeredBy: institution.owner, offeredAt: new Date('2026-08-20T00:00:00+05:00'), respondedAt: new Date('2026-08-22T00:00:00+05:00'), startedAt: new Date('2026-09-01T00:00:00+05:00'), endReason: '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!(institution.staff || []).some((member) => member.user?.toString() === warden._id.toString())) {
    institution.staff.push({ user: warden._id, role: 'warden', designation: 'Senior Hostel Warden', department: 'Student Affairs & Hostel Administration', permissions: ['institution:ops:manage', 'hostel:rooms:read', 'hostel:attendance:manage', 'hostel:requests:manage'] });
  } else {
    const staffRecord = institution.staff.find((member) => member.user?.toString() === warden._id.toString());
    staffRecord.role = 'warden';
    staffRecord.designation = 'Senior Hostel Warden';
    staffRecord.department = 'Student Affairs & Hostel Administration';
    staffRecord.permissions = ['institution:ops:manage', 'hostel:rooms:read', 'hostel:attendance:manage', 'hostel:requests:manage'];
  }
  await institution.save();
  await HostelRoom.findOneAndUpdate(
    { institution: institution._id, roomNumber: 'A-101' },
    { $set: { building: 'Hostel Block A', floor: 'Ground Floor', capacity: 2, monthlyFee: hostel.amount + hostel.messMonthlyAmount, warden: warden._id }, $setOnInsert: { occupants: [], status: 'available' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const [applicationCheck, roomCheck, voucherCheck] = await Promise.all([
    InstitutionApplication.findOne({ institution: institution._id, applicant: student._id, status: 'accepted', 'requestedServices.hostel': true }).lean(),
    HostelRoom.findOne({ institution: institution._id, roomNumber: 'A-101' }).lean(),
    Fee.findOne({ institution: institution._id, student: student._id, feeType: 'hostel', billingPeriod }).lean()
  ]);
  console.log('[SEED] Mohammad Omar hostel QA data verified:', {
    applicationId: applicationCheck?._id,
    hostel: applicationCheck?.requestedServices?.hostel,
    mess: applicationCheck?.requestedServices?.mess,
    room: roomCheck?.roomNumber,
    recurringMonthlyFee: roomCheck?.monthlyFee,
    voucher: voucherCheck?.amount,
    voucherStatus: voucherCheck?.status
  });
  console.log('[SEED] Warden login:', { email: warden.email, password: 'CareerZ@123', name: warden.fullName, phone: warden.phone, designation: 'Senior Hostel Warden' });
  console.log('[SEED] GCUF institution wallet available balance:', targetBalance, 'PKR');
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[SEED] Mohammad hostel seed failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
