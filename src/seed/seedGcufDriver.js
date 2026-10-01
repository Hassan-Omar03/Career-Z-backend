require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Institution = require('../models/Institution');
const InstitutionProgram = require('../models/InstitutionProgram');
const InstitutionApplication = require('../models/InstitutionApplication');
const FeeSchedule = require('../models/FeeSchedule');
const TeacherEmployment = require('../models/TeacherEmployment');
const PayoutProfile = require('../models/PayoutProfile');
const Vehicle = require('../models/Vehicle');

async function run() {
  await connectDB();
  const institution = await Institution.findOne({ slug: 'gcuf' });
  const student = await User.findOne({ email: 'baitcvs@gmail.com' });
  const program = await InstitutionProgram.findOne({ institution: institution?._id, name: 'BS Computer Science' });
  if (!institution || !student || !program) throw new Error('Run the main and Mohammad hostel seeds first.');
  if (institution.type === 'online_institute') throw new Error('Transport is available only for a physical institution.');

  const transportFee = 6000;
  program.additionalFees.transport = { enabled: true, amount: transportFee, recurrence: 'every_cycle' };
  program.billingFrequency = 'semester';
  program.numberOfTerms = Math.max(2, Number(program.numberOfTerms) || 2);
  program.installmentsPerBillingCycle = Math.max(1, Number(program.installmentsPerBillingCycle) || 1);
  await program.save();

  const application = await InstitutionApplication.findOne({ institution: institution._id, applicant: student._id, program: program.name });
  if (!application) throw new Error('Mohammad Omar accepted application is missing.');
  application.requestedServices.transport = true;
  application.feePlanSnapshot.additionalFees.transport = { enabled: true, amount: transportFee, recurrence: 'every_cycle' };
  application.notes = `${application.notes || ''} QA transport requested during admission.`.trim();
  await application.save();
  await FeeSchedule.updateOne(
    { institution: institution._id, student: student._id, program: program._id },
    { $set: { 'additionalFees.transport': { enabled: true, amount: transportFee, recurrence: 'every_cycle' }, billingFrequency: 'semester', numberOfTerms: program.numberOfTerms, installmentsPerBillingCycle: program.installmentsPerBillingCycle } }
  );

  let driver = await User.findOne({ email: 'gcuf.driver@careerz.local' });
  const userData = {
    fullName: 'Muhammad Imran',
    passwordHash: await User.hashPassword('CareerZ@123'),
    roles: ['institution_staff'], emailVerified: true, phoneVerified: true,
    phone: '+923117654321', country: 'PK', language: 'en', currency: 'PKR', status: 'active',
    companyName: 'GCUF Transport Department'
  };
  if (driver) Object.assign(driver, userData);
  else driver = new User({ email: 'gcuf.driver@careerz.local', ...userData });
  await driver.save();

  await TeacherEmployment.findOneAndUpdate(
    { teacher: driver._id, institution: institution._id, status: { $in: ['offered', 'active'] } },
    { $set: { role: 'driver', designation: 'University Bus Driver', department: 'Transport Department', contractTerms: 'Full-time institutional driver. Responsible for assigned vehicle, route safety, student boarding, journey tracking, fuel logs and incident reporting.', salaryType: 'monthly', monthlySalary: 50000, salaryCurrency: 'PKR', taxPercent: 0, commissionPercent: 0, status: 'active', offeredBy: institution.owner, offeredAt: new Date('2026-09-20T00:00:00+05:00'), respondedAt: new Date('2026-09-21T00:00:00+05:00'), startedAt: new Date('2026-10-01T00:00:00+05:00') } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await PayoutProfile.findOneAndUpdate(
    { user: driver._id },
    { $set: { preferredMethod: 'bank_transfer', bank: { accountTitle: driver.fullName, bankName: 'HBL', iban: 'PK00HABB0000009876543210', accountNumber: '9876543210' }, mobileWallet: { provider: 'JazzCash', accountTitle: driver.fullName, number: '03117654321' }, crypto: { asset: 'USDT', network: 'TRC20', address: 'TQaDriverQAAddress987654321' } } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const index = (institution.staff || []).findIndex((entry) => entry.user?.toString() === driver._id.toString());
  const staffData = { user: driver._id, role: 'driver', designation: 'University Bus Driver', department: 'Transport Department', permissions: ['transport:manage'] };
  if (index < 0) institution.staff.push(staffData);
  else Object.assign(institution.staff[index], staffData);
  await institution.save();

  const vehicle = await Vehicle.findOneAndUpdate(
    { institution: institution._id, vehicleNumber: 'GCUF-BUS-01' },
    { $set: { type: 'bus', capacity: 40, driverName: driver.fullName, driverPhone: driver.phone, driverLicenseNo: 'LHR-HTV-2026-001', driverUser: driver._id, routeName: 'Clock Tower – GCUF Main Campus', stopPoints: [{ name: 'Clock Tower Faisalabad', time: '07:15 AM', lat: 31.41871, lng: 73.07909 }, { name: 'D Ground Faisalabad', time: '07:35 AM', lat: 31.406638, lng: 73.109585 }, { name: 'GCUF Main Campus', time: '08:00 AM', lat: 31.41587, lng: 73.06869 }], monthlyFee: transportFee, currency: 'PKR', expectedDurationMinutes: 45, insuranceExpiry: new Date('2027-09-30'), fitnessExpiry: new Date('2027-06-30'), status: 'active' }, $setOnInsert: { assignedStudents: [], addedBy: institution.owner } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('[SEED] GCUF driver and transport ready:', {
    login: driver.email, password: 'CareerZ@123', driver: driver.fullName,
    employment: 'active', salary: 'PKR 50000', vehicle: vehicle.vehicleNumber,
    route: vehicle.routeName, studentEligible: student.fullName, transportFee
  });
}

run().then(() => mongoose.disconnect()).then(() => process.exit(0)).catch(async (error) => {
  console.error('[SEED] GCUF driver seed failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
