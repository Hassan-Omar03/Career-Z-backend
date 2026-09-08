const Institution = require('../models/Institution');
const Campus = require('../models/Campus');
const ClassSection = require('../models/ClassSection');
const Fee = require('../models/Fee');
const TimetableEntry = require('../models/TimetableEntry');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const Attendance = require('../models/Attendance');
const Payslip = require('../models/Payslip');
const Course = require('../models/Course');
const Exam = require('../models/Exam');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// POST /api/institutions
const registerInstitution = asyncHandler(async (req, res) => {
  const { name, type, country, city, address, description, contactEmail, contactPhone, website } = req.body;
  if (!name || !type || !country) throw new AppError('Name, type and country are required.', 422);

  let slug = slugify(name);
  const clash = await Institution.findOne({ slug });
  if (clash) slug = `${slug}-${Date.now().toString(36)}`;

  const institution = await Institution.create({
    owner: req.user._id,
    name,
    slug,
    type,
    country,
    city,
    address,
    description,
    contactEmail,
    contactPhone,
    website
  });

  // Ensure the creator holds the institution_owner role.
  if (!req.user.roles.includes('institution_owner') && !req.user.roles.includes('academy_owner')) {
    req.user.roles.push('institution_owner');
    await req.user.save();
  }

  return created(res, institution, 'Institution registered. Submit documents for verification.');
});

// GET /api/institutions (public listing, approved + active only)
const listInstitutions = asyncHandler(async (req, res) => {
  const { country, type, q } = req.query;
  const filter = { status: 'active', verificationStatus: 'approved' };
  if (country) filter.country = country;
  if (type) filter.type = type;
  if (q) filter.name = { $regex: q, $options: 'i' };

  const institutions = await Institution.find(filter).select('-verificationDocuments -staff').sort({ name: 1 });
  return ok(res, institutions);
});

// GET /api/institutions/admin/all (admin/platform_staff — every status, for verification review)
const adminListAll = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({}).select('-verificationDocuments -staff').sort({ createdAt: -1 });
  return ok(res, institutions);
});

// GET /api/institutions/mine (owner's institutions)
const myInstitutions = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({
    $or: [{ owner: req.user._id }, { 'staff.user': req.user._id }]
  });
  return ok(res, institutions);
});

// GET /api/institutions/:id
const getInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id).populate('owner', 'fullName email');
  if (!institution) throw new AppError('Institution not found.', 404);
  return ok(res, institution);
});

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
  return isOwner;
}

// PATCH /api/institutions/:id
const updateInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const allowed = ['name', 'city', 'address', 'description', 'contactEmail', 'contactPhone', 'website', 'logo', 'coverImage'];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) institution[field] = req.body[field];
  });
  await institution.save();
  return ok(res, institution);
});

// POST /api/institutions/:id/verification-documents
const submitVerificationDocuments = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (institution.owner.toString() !== req.user._id.toString()) {
    throw new AppError('Only the owner can submit verification documents.', 403);
  }

  const { documents } = req.body; // array of file URLs
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new AppError('At least one document is required.', 422);
  }

  institution.verificationDocuments.push(...documents);
  institution.verificationStatus = 'under_review';
  await institution.save();

  return ok(res, institution, 'Documents submitted for review.');
});

// PATCH /api/institutions/:id/verify (admin/platform_staff)
const reviewVerification = asyncHandler(async (req, res) => {
  const { decision, notes } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('Decision must be approved or rejected.', 422);

  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);

  institution.verificationStatus = decision;
  await institution.save();

  return ok(res, institution, `Institution verification ${decision}.`);
});

// POST /api/institutions/:id/staff
const addStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);

  const { userId, role, permissions } = req.body;
  if (!userId || !role) throw new AppError('userId and role are required.', 422);

  const alreadyStaff = institution.staff.some((s) => s.user.toString() === userId);
  if (alreadyStaff) throw new AppError('User is already staff at this institution.', 409);

  institution.staff.push({ user: userId, role, permissions: permissions || [] });
  await institution.save();

  const User = require('../models/User');
  const staffUser = await User.findById(userId);
  if (staffUser && !staffUser.roles.includes('institution_staff')) {
    staffUser.roles.push('institution_staff');
    await staffUser.save();
  }

  return ok(res, institution, 'Staff member added.');
});

// DELETE /api/institutions/:id/staff/:userId
const removeStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);

  institution.staff = institution.staff.filter((s) => s.user.toString() !== req.params.userId);
  await institution.save();
  return ok(res, institution, 'Staff member removed.');
});

// ---- Campuses ----
const createCampus = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const campus = await Campus.create({ institution: institution._id, ...req.body });
  return created(res, campus);
});

const listCampuses = asyncHandler(async (req, res) => {
  const campuses = await Campus.find({ institution: req.params.id });
  return ok(res, campuses);
});

// ---- Class Sections ----
const createClassSection = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const section = await ClassSection.create({ institution: institution._id, ...req.body });
  return created(res, section);
});

const listClassSections = asyncHandler(async (req, res) => {
  const sections = await ClassSection.find({ institution: req.params.id });
  return ok(res, sections);
});

// ---- Fees ----
const createFee = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { student, title, amount, currency, dueDate } = req.body;
  if (!student || !title || amount === undefined) {
    throw new AppError('student, title and amount are required.', 422);
  }

  const fee = await Fee.create({
    student,
    institution: institution._id,
    title,
    amount,
    currency: currency || 'USD',
    dueDate: dueDate || null,
    recordedBy: req.user._id
  });

  return created(res, fee, 'Fee recorded.');
});

const listFees = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const fees = await Fee.find({ institution: institution._id }).populate('student', 'fullName email').sort({ createdAt: -1 });
  return ok(res, fees);
});

const markFeePaid = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);

  const institution = await Institution.findById(fee.institution);
  assertOwnerOrStaff(institution, req.user._id);

  const { paidVia } = req.body;
  fee.status = 'paid';
  fee.paidAt = new Date();
  fee.paidVia = paidVia || '';
  await fee.save();

  return ok(res, fee, 'Fee marked as paid.');
});

// ---- Timetable ----
const createTimetableEntry = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const section = await ClassSection.findById(req.params.sectionId);
  if (!section || section.institution.toString() !== institution._id.toString()) {
    throw new AppError('Class section not found for this institution.', 404);
  }

  const { teacher, subject, dayOfWeek, startTime, endTime, room, meetingLink } = req.body;
  if (!subject || !dayOfWeek || !startTime || !endTime) {
    throw new AppError('subject, dayOfWeek, startTime and endTime are required.', 422);
  }

  const entry = await TimetableEntry.create({
    institution: institution._id,
    classSection: section._id,
    teacher: teacher || null,
    subject,
    dayOfWeek,
    startTime,
    endTime,
    room: room || '',
    meetingLink: meetingLink || '',
    createdBy: req.user._id
  });

  return created(res, entry, 'Timetable entry added.');
});

const listTimetable = asyncHandler(async (req, res) => {
  const entries = await TimetableEntry.find({ classSection: req.params.sectionId })
    .populate('teacher', 'fullName')
    .sort({ dayOfWeek: 1, startTime: 1 });
  return ok(res, entries);
});

const deleteTimetableEntry = asyncHandler(async (req, res) => {
  const entry = await TimetableEntry.findById(req.params.entryId);
  if (!entry) throw new AppError('Timetable entry not found.', 404);

  const institution = await Institution.findById(entry.institution);
  assertOwnerOrStaff(institution, req.user._id);

  await entry.deleteOne();
  return ok(res, { deleted: true }, 'Timetable entry removed.');
});

// ---- Teacher / Student Management ----
const listInstitutionTeachers = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const teachers = await TeacherProfile.find({ institutions: institution._id })
    .populate('user', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, teachers);
});

const listInstitutionStudents = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const students = await StudentProfile.find({ primaryInstitution: institution._id })
    .populate('user', 'fullName email')
    .populate('classSection', 'name')
    .sort({ createdAt: -1 });
  return ok(res, students);
});

const updateStudentStatus = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findById(req.params.profileId);
  if (!profile) throw new AppError('Student profile not found.', 404);

  const institution = await Institution.findById(profile.primaryInstitution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { status } = req.body;
  if (!['active', 'suspended', 'graduated', 'transferred'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }
  profile.status = status;
  await profile.save();
  return ok(res, profile, 'Student status updated.');
});

// ---- Attendance Management (institution-wide reporting) ----
const listInstitutionAttendance = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { from, to } = req.query;
  const filter = { institution: institution._id };
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }

  const records = await Attendance.find(filter)
    .populate('markedBy', 'fullName')
    .populate('classSection', 'name')
    .sort({ date: -1 })
    .limit(200);

  const summary = { present: 0, absent: 0, late: 0, excused: 0 };
  records.forEach((r) => r.records.forEach((entry) => { summary[entry.status] = (summary[entry.status] || 0) + 1; }));

  return ok(res, { records, summary });
});

// ---- Payroll ----
const createPayslip = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { staff, month, year, basicSalary, bonuses, deductions, currency } = req.body;
  if (!staff || !month || !year || basicSalary === undefined) {
    throw new AppError('staff, month, year and basicSalary are required.', 422);
  }

  const netAmount = Number(basicSalary) + Number(bonuses || 0) - Number(deductions || 0);
  const payslip = await Payslip.create({
    institution: institution._id,
    staff,
    month,
    year,
    basicSalary,
    bonuses: bonuses || 0,
    deductions: deductions || 0,
    netAmount,
    currency: currency || 'USD',
    generatedBy: req.user._id
  });

  return created(res, payslip, 'Payslip generated.');
});

const listInstitutionPayroll = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const payslips = await Payslip.find({ institution: institution._id })
    .populate('staff', 'fullName email')
    .sort({ year: -1, month: -1 });
  return ok(res, payslips);
});

const markPayslipPaid = asyncHandler(async (req, res) => {
  const payslip = await Payslip.findById(req.params.payslipId);
  if (!payslip) throw new AppError('Payslip not found.', 404);

  const institution = await Institution.findById(payslip.institution);
  assertOwnerOrStaff(institution, req.user._id);

  payslip.status = 'paid';
  payslip.paidAt = new Date();
  await payslip.save();
  return ok(res, payslip, 'Payslip marked as paid.');
});

// ---- Reports ----
const getInstitutionReports = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const [studentsCount, teachersCount, classSectionsCount, campusesCount, feeAgg, attendanceRecords, pendingPayroll] = await Promise.all([
    StudentProfile.countDocuments({ primaryInstitution: institution._id }),
    TeacherProfile.countDocuments({ institutions: institution._id }),
    ClassSection.countDocuments({ institution: institution._id }),
    Campus.countDocuments({ institution: institution._id }),
    Fee.aggregate([
      { $match: { institution: institution._id } },
      { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Attendance.find({ institution: institution._id }).sort({ date: -1 }).limit(100),
    Payslip.countDocuments({ institution: institution._id, status: 'pending' })
  ]);

  const fees = { collected: 0, pending: 0, overdue: 0, collectedCount: 0, pendingCount: 0, overdueCount: 0 };
  feeAgg.forEach((row) => {
    if (row._id === 'paid') { fees.collected = row.total; fees.collectedCount = row.count; }
    if (row._id === 'pending') { fees.pending = row.total; fees.pendingCount = row.count; }
    if (row._id === 'overdue') { fees.overdue = row.total; fees.overdueCount = row.count; }
  });

  let present = 0;
  let total = 0;
  attendanceRecords.forEach((r) => r.records.forEach((entry) => {
    total += 1;
    if (entry.status === 'present') present += 1;
  }));
  const attendanceRate = total > 0 ? Math.round((present / total) * 100) : null;

  return ok(res, {
    staffCount: institution.staff.length,
    studentsCount,
    teachersCount,
    classSectionsCount,
    campusesCount,
    fees,
    attendanceRate,
    pendingPayroll
  });
});

// ---- Examination Management (institution-wide view) ----
const listInstitutionExams = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const courses = await Course.find({ institution: institution._id }).select('_id title teacher');
  const courseIds = courses.map((c) => c._id);
  const courseMap = Object.fromEntries(courses.map((c) => [c._id.toString(), c.title]));

  const exams = await Exam.find({ course: { $in: courseIds } })
    .populate('teacher', 'fullName')
    .sort({ scheduledDate: -1 });

  const withCourseTitle = exams.map((e) => ({ ...e.toObject(), courseTitle: courseMap[e.course.toString()] }));
  return ok(res, withCourseTitle);
});

module.exports = {
  registerInstitution,
  listInstitutions,
  myInstitutions,
  getInstitution,
  updateInstitution,
  submitVerificationDocuments,
  reviewVerification,
  adminListAll,
  addStaff,
  removeStaff,
  createCampus,
  listCampuses,
  createClassSection,
  listClassSections,
  createFee,
  listFees,
  markFeePaid,
  createTimetableEntry,
  listTimetable,
  deleteTimetableEntry,
  listInstitutionTeachers,
  listInstitutionStudents,
  updateStudentStatus,
  listInstitutionAttendance,
  createPayslip,
  listInstitutionPayroll,
  markPayslipPaid,
  getInstitutionReports,
  listInstitutionExams
};
