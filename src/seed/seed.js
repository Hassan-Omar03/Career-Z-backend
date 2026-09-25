const User = require('../models/User');
const Country = require('../models/Country');
const Language = require('../models/Language');
const Currency = require('../models/Currency');
const FeatureFlag = require('../models/FeatureFlag');
const Institution = require('../models/Institution');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const ClassSection = require('../models/ClassSection');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const TimetableEntry = require('../models/TimetableEntry');
const Exam = require('../models/Exam');

const countries = [
  { name: 'Pakistan', code: 'PK', dialCode: '+92', defaultCurrency: 'PKR', defaultLanguage: 'ur', timeZone: 'Asia/Karachi', dateFormat: 'DD/MM/YYYY' },
  { name: 'Saudi Arabia', code: 'SA', dialCode: '+966', defaultCurrency: 'SAR', defaultLanguage: 'ar', timeZone: 'Asia/Riyadh', dateFormat: 'DD/MM/YYYY' },
  { name: 'United Arab Emirates', code: 'AE', dialCode: '+971', defaultCurrency: 'AED', defaultLanguage: 'ar', timeZone: 'Asia/Dubai', dateFormat: 'DD/MM/YYYY' },
  { name: 'United States', code: 'US', dialCode: '+1', defaultCurrency: 'USD', defaultLanguage: 'en', timeZone: 'America/New_York', dateFormat: 'MM/DD/YYYY' },
  { name: 'United Kingdom', code: 'GB', dialCode: '+44', defaultCurrency: 'GBP', defaultLanguage: 'en', timeZone: 'Europe/London', dateFormat: 'DD/MM/YYYY' }
];

const languages = [
  { name: 'English', code: 'en', direction: 'ltr', isDefault: true },
  { name: 'Urdu', code: 'ur', direction: 'rtl' },
  { name: 'Arabic', code: 'ar', direction: 'rtl' }
];

const currencies = [
  { name: 'US Dollar', code: 'USD', symbol: '$', symbolPosition: 'left', isDefault: true, exchangeRateToUSD: 1 },
  { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', symbolPosition: 'left', exchangeRateToUSD: 0.0036 },
  { name: 'Saudi Riyal', code: 'SAR', symbol: 'SAR', symbolPosition: 'left', exchangeRateToUSD: 0.27 },
  { name: 'UAE Dirham', code: 'AED', symbol: 'AED', symbolPosition: 'left', exchangeRateToUSD: 0.27 },
  { name: 'British Pound', code: 'GBP', symbol: '£', symbolPosition: 'left', exchangeRateToUSD: 1.27 }
];

const featureFlags = [
  { key: 'jobs', label: 'Jobs & Recruitment', enabled: true },
  { key: 'marketplace', label: 'Marketplace', enabled: true },
  { key: 'scholarships', label: 'Scholarships & Donations', enabled: true },
  { key: 'ai_assistant', label: 'AI Assistant', enabled: true },
  { key: 'freelancer_hub', label: 'Freelancer & Services Hub', enabled: true },
  { key: 'advertisements', label: 'Advertisements', enabled: false }
];

async function ensureUser({ fullName, email, roles }) {
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ fullName, email, passwordHash: await User.hashPassword('CareerZ@123'), roles, emailVerified: true, country: 'PK', language: 'en', currency: 'PKR' });
  } else {
    user.roles = [...new Set([...(user.roles || []), ...roles])];
    user.emailVerified = true;
    await user.save();
  }
  return user;
}

async function seedGcufAcademicDemo() {
  let institution = await Institution.findOne({ $or: [{ slug: 'gcuf' }, { name: { $regex: /^GCUF$/i } }, { name: { $regex: /Government College University Faisalabad/i } }] });
  if (!institution) {
    const owner = await ensureUser({ fullName: 'GCUF Institute Admin', email: 'gcuf.admin@careerz.local', roles: ['institution_owner'] });
    institution = await Institution.create({ owner: owner._id, name: 'GCUF', slug: 'gcuf', type: 'university', country: 'PK', city: 'Faisalabad', address: 'Kotwali Road, Faisalabad', contactEmail: 'gcuf.admin@careerz.local', description: 'Government College University Faisalabad academic testing institution.', verificationStatus: 'approved', status: 'active' });
  }

  const teacherSpecs = [
    { fullName: 'Hassan', email: 'hassanomar3345@gmail.com', subjects: ['Introduction to Computing', 'Programming Fundamentals'], qualification: 'MS Computer Science' },
    { fullName: 'Dr. Ayesha Khalid', email: 'ayesha.teacher@careerz.local', subjects: ['Discrete Structures'], qualification: 'PhD Computer Science' },
    { fullName: 'Engr. Bilal Ahmed', email: 'bilal.teacher@careerz.local', subjects: ['Digital Logic Design'], qualification: 'MS Computer Engineering' }
  ];
  const teachers = [];
  for (const spec of teacherSpecs) {
    const user = await ensureUser({ fullName: spec.fullName, email: spec.email, roles: ['teacher'] });
    await TeacherProfile.findOneAndUpdate(
      { user: user._id },
      { $set: { subjects: spec.subjects, experienceYears: spec.fullName.startsWith('Dr.') ? 9 : 6, bio: `${spec.qualification} faculty member for GCUF BS Computer Science.`, status: 'active' }, $addToSet: { institutions: institution._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!(institution.staff || []).some((member) => member.user?.toString() === user._id.toString())) institution.staff.push({ user: user._id, role: 'teacher', designation: 'Lecturer', department: 'Computer Science', permissions: [] });
    teachers.push(user);
  }
  await institution.save();

  const section = await ClassSection.findOneAndUpdate(
    { institution: institution._id, name: 'BS Computer Science - Semester 1 - A' },
    { $set: { academicYear: '2026-2030', classTeacher: teachers[0]._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const courseSpecs = [
    { title: 'Introduction to Computing Application', subject: 'Introduction to Computing', teacher: teachers[0], description: 'Computer systems, software, networks, digital citizenship and practical computing foundations.' },
    { title: 'Programming Fundamentals', subject: 'Programming Fundamentals', teacher: teachers[0], description: 'Problem solving, algorithms, flowcharts and programming fundamentals using C++.' },
    { title: 'Discrete Structures', subject: 'Discrete Structures', teacher: teachers[1], description: 'Logic, sets, relations, functions, combinatorics, graphs and mathematical reasoning.' },
    { title: 'Digital Logic Design', subject: 'Digital Logic Design', teacher: teachers[2], description: 'Number systems, Boolean algebra, logic gates and combinational digital circuits.' }
  ];
  const courses = [];
  for (const spec of courseSpecs) {
    courses.push(await Course.findOneAndUpdate(
      { institution: institution._id, title: spec.title },
      { $set: { description: spec.description, teacher: spec.teacher._id, classSection: section._id, subject: spec.subject, level: 'BS Computer Science - Semester 1', language: 'en', price: 0, currency: 'PKR', isFree: false, published: true, certificateEnabled: true, testOnly: false } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ));
  }

  const student = await User.findOne({ email: 'baitcvs@gmail.com' });
  if (student) {
    await StudentProfile.findOneAndUpdate({ user: student._id }, { $set: { primaryInstitution: institution._id, classSection: section._id, program: 'BS Computer Science', currentTerm: 'Semester 1', rollNumber: 'BSCS-2026-001', status: 'active' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    for (const course of courses) await Enrollment.findOneAndUpdate({ student: student._id, course: course._id }, { $setOnInsert: { status: 'active', progressPercent: 0, overallScore: 0, completionStatus: 'in_progress' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  }

  const timetableSpecs = [
    { course: courses[0], teacher: teachers[0], dayOfWeek: 'mon', startTime: '09:00', endTime: '10:00', room: 'CS-101' },
    { course: courses[1], teacher: teachers[0], dayOfWeek: 'tue', startTime: '10:00', endTime: '11:30', room: 'Programming Lab 1' },
    { course: courses[2], teacher: teachers[1], dayOfWeek: 'wed', startTime: '09:00', endTime: '10:30', room: 'CS-203' },
    { course: courses[3], teacher: teachers[2], dayOfWeek: 'thu', startTime: '11:00', endTime: '12:30', room: 'Digital Lab' },
    { course: courses[1], teacher: teachers[0], dayOfWeek: 'fri', startTime: '09:00', endTime: '10:30', room: 'Programming Lab 1' }
  ];
  for (const slot of timetableSpecs) await TimetableEntry.findOneAndUpdate(
    { institution: institution._id, classSection: section._id, course: slot.course._id, dayOfWeek: slot.dayOfWeek, startTime: slot.startTime },
    { $set: { teacher: slot.teacher._id, subject: slot.course.subject, endTime: slot.endTime, room: slot.room, meetingLink: '', createdBy: institution.owner } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const examQuestions = [
    { text: 'Which component performs arithmetic and logical operations in a computer?', type: 'mcq', options: ['RAM', 'ALU', 'SSD', 'Power supply'], correctOption: 1, marks: 2 },
    { text: 'Which memory loses its contents when power is switched off?', type: 'mcq', options: ['ROM', 'SSD', 'RAM', 'Flash memory'], correctOption: 2, marks: 2 },
    { text: 'Which protocol is primarily used to securely browse websites?', type: 'mcq', options: ['FTP', 'HTTP', 'HTTPS', 'SMTP'], correctOption: 2, marks: 2 },
    { text: 'What is the main purpose of an operating system?', type: 'mcq', options: ['Only create documents', 'Manage hardware and software resources', 'Design websites', 'Replace the CPU'], correctOption: 1, marks: 2 },
    { text: 'Binary number 1010 is equal to which decimal number?', type: 'mcq', options: ['8', '10', '12', '14'], correctOption: 1, marks: 2 },
    { text: 'Differentiate between system software and application software, giving one example of each.', type: 'short', options: [], marks: 5 },
    { text: 'Explain two benefits and two risks of using cloud storage in education.', type: 'short', options: [], marks: 5 },
    { text: 'Explain the complete input-process-output-storage cycle of a computer system. Use a practical university example and identify the hardware or software involved at every stage.', type: 'long', options: [], marks: 15 },
    { text: 'Discuss how computers, networks and information systems support a modern university. Cover teaching, assessment, administration, security, privacy and responsible digital use with relevant examples.', type: 'long', options: [], marks: 15 }
  ];
  const now = Date.now();
  await Exam.findOneAndUpdate(
    { course: courses[0]._id, title: 'Introduction to Computing — Comprehensive Test' },
    { $set: { teacher: teachers[0]._id, institution: institution._id, classSection: section._id, subject: courses[0].subject, academicSession: '2026-2030', term: 'Semester 1', type: 'test', durationMinutes: 90, scheduledDate: new Date(now - 60 * 60 * 1000), closesAt: new Date(now + 7 * 24 * 60 * 60 * 1000), passingPercent: 50, venue: 'Online — CareerZ Examination Portal', instructions: 'Attempt every question. The teacher reviews and grades every MCQ and written answer. Write detailed answers for long questions.', questions: examQuestions, published: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`[SEED] GCUF demo ensured: ${teachers.length} teachers, ${courses.length} BSCS courses, ${timetableSpecs.length} timetable slots, 1 mixed-question exam${student ? ', student enrolled' : ', baitcvs@gmail.com not found'}.`);
}

// Idempotent - safe to call every time the server starts (uses upsert / existence checks).
// Does NOT open or close the database connection - the caller is responsible for that.
async function runSeedData() {
  for (const c of countries) {
    await Country.findOneAndUpdate({ code: c.code }, c, { upsert: true, new: true });
  }
  for (const l of languages) {
    await Language.findOneAndUpdate({ code: l.code }, l, { upsert: true, new: true });
  }
  for (const cur of currencies) {
    await Currency.findOneAndUpdate({ code: cur.code }, cur, { upsert: true, new: true });
  }
  for (const f of featureFlags) {
    await FeatureFlag.findOneAndUpdate({ key: f.key, scope: 'global', scopeValue: null }, f, { upsert: true, new: true });
  }
  console.log(`[SEED] Countries/Languages/Currencies/FeatureFlags ensured (${countries.length}/${languages.length}/${currencies.length}/${featureFlags.length}).`);

  const adminEmail = 'superadmin@careerz.local';
  const existingAdmin = await User.findOne({ email: adminEmail });
  if (!existingAdmin) {
    const passwordHash = await User.hashPassword('SuperAdmin@123');
    await User.create({
      fullName: 'CareerZ Super Admin',
      email: adminEmail,
      passwordHash,
      roles: ['super_admin'],
      emailVerified: true,
      country: 'PK',
      language: 'en'
    });
    console.log('[SEED] Super Admin created -> email: superadmin@careerz.local / password: SuperAdmin@123');
    console.log('[SEED] Change this password immediately after first login.');
  } else {
    console.log('[SEED] Super Admin already exists, skipping.');
  }
  await seedGcufAcademicDemo();
}

module.exports = { runSeedData };

// Allows `npm run seed` to be executed standalone against a real MONGO_URI
// (this only makes sense with USE_MEMORY_DB=false, since a standalone run's
// in-memory database is discarded the moment this process exits).
if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../config/db');

  (async () => {
    try {
      await connectDB();
      await runSeedData();
      console.log('[SEED] Done.');
      await mongoose.disconnect();
      process.exit(0);
    } catch (err) {
      console.error('[SEED] Failed:', err);
      process.exit(1);
    }
  })();
}
