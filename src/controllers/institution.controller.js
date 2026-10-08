const crypto = require('crypto');
const mongoose = require('mongoose');
const Institution = require('../models/Institution');
const Campus = require('../models/Campus');
const ClassSection = require('../models/ClassSection');
const Fee = require('../models/Fee');
const TimetableEntry = require('../models/TimetableEntry');
const InstitutionProgram = require('../models/InstitutionProgram');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const Attendance = require('../models/Attendance');
const StaffAttendance = require('../models/StaffAttendance');
const CampusBuilding = require('../models/CampusBuilding');
const Payslip = require('../models/Payslip');
const PayoutProfile = require('../models/PayoutProfile');
const TeacherEmployment = require('../models/TeacherEmployment');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Course = require('../models/Course');
const CoursePurchase = require('../models/CoursePurchase');
const Enrollment = require('../models/Enrollment');
const Exam = require('../models/Exam');
const User = require('../models/User');
const Inquiry = require('../models/Inquiry');
const InstitutionApplication = require('../models/InstitutionApplication');
const Meeting = require('../models/Meeting');
const Notification = require('../models/Notification');
const Message = require('../models/Message');
const ParentChildLink = require('../models/ParentChildLink');
const RoleRequest = require('../models/RoleRequest');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyParentsOfStudent, notifyAdmins } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');
const { PAYOUT_METHOD_LABEL } = require('../utils/paymentMethods');
const { computeReceiptAmounts } = require('../utils/receiptCalc');
const { assertStaffCapAllows } = require('../utils/subscriptionGate');
const { recordJoin, recordLeave } = require('../utils/institutionMembership');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const { onboardStaff, offboardStaff } = require('../utils/staffOnboarding');

const FEE_COMMISSION_KEY = 'fee_commission_percent';

const DOW_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

const createProgram = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const { name, department, classSection, durationTerms, admissionFee, totalTuitionFee, installments, currency, additionalFees = {} } = req.body;
  if (!name || !department || !classSection || totalTuitionFee === undefined) throw new AppError('name, department, classSection and totalTuitionFee are required.', 422);
  if (!Number.isFinite(Number(totalTuitionFee)) || Number(totalTuitionFee) <= 0) throw new AppError('Total degree tuition must be greater than zero.', 422);
  const section = await ClassSection.findOne({ _id: classSection, institution: institution._id });
  if (!section) throw new AppError('Class section does not belong to this institution.', 422);
  if (institution.type === 'online_institute' && additionalFees.hostel?.enabled) throw new AppError('Online institutions cannot offer hostel accommodation.', 422);
  const normalizedAdditionalFees = {};
  for (const type of ['exam', 'hostel', 'transport', 'library', 'activity']) {
    normalizedAdditionalFees[type] = { enabled: Boolean(additionalFees[type]?.enabled), amount: Boolean(additionalFees[type]?.enabled) ? Number(additionalFees[type]?.amount) || 0 : 0 };
    if (type === 'hostel') normalizedAdditionalFees[type] = { ...normalizedAdditionalFees[type], securityDeposit: Number(additionalFees[type]?.securityDeposit) || 0, messAvailable: Boolean(additionalFees[type]?.messAvailable), messMonthlyAmount: Number(additionalFees[type]?.messMonthlyAmount) || 0, recurrence: 'every_cycle' };
  }
  const program = await InstitutionProgram.create({ institution: institution._id, name, department, classSection, durationTerms: Number(durationTerms) || 8, admissionFee: Number(admissionFee) || 0, totalTuitionFee: Number(totalTuitionFee), installments: Number(installments) || Number(durationTerms) || 8, currency: currency || 'PKR', additionalFees: normalizedAdditionalFees, createdBy: req.user._id });

  // Apply a newly configured plan to students who were accepted before fee plans existed.
  const students = await StudentProfile.find({ primaryInstitution: institution._id, program: name });
  const programCourses = await Course.find({ institution: institution._id, classSection: section._id, published: true });
  for (const student of students) {
    student.classSection = section._id;
    await student.save();
    await Promise.all(programCourses.map((course) => Enrollment.updateOne(
      { student: student.user, course: course._id },
      { $setOnInsert: { student: student.user, course: course._id, status: 'active' } },
      { upsert: true }
    )));
    const planId = `program-${program._id}-${student.user}`;
    if (!(await Fee.exists({ student: student.user, institution: institution._id, 'installment.planId': planId }))) {
      const feeRows = [];
      if (program.admissionFee > 0) feeRows.push({ student: student.user, institution: institution._id, title: `${program.name} Admission Fee`, feeType: 'admission', amount: program.admissionFee, currency: program.currency, dueDate: new Date(), installment: { planId, number: 0, totalInstallments: program.installments }, recordedBy: req.user._id });
      for (const type of ['exam', 'hostel', 'transport', 'library', 'activity']) {
        const extra = program.additionalFees?.[type];
        if (extra?.enabled && extra.amount > 0) feeRows.push({ student: student.user, institution: institution._id, title: `${program.name} ${type.charAt(0).toUpperCase() + type.slice(1)} Fee`, feeType: type, amount: extra.amount, currency: program.currency, dueDate: new Date(), installment: { planId, number: 0, totalInstallments: program.installments }, recordedBy: req.user._id });
      }
      let allocated = 0;
      for (let number = 1; number <= program.installments; number += 1) {
        const amount = number === program.installments ? Math.round((program.totalTuitionFee - allocated) * 100) / 100 : Math.round((program.totalTuitionFee / program.installments) * 100) / 100;
        allocated += amount;
        const dueDate = new Date(); dueDate.setMonth(dueDate.getMonth() + number - 1);
        feeRows.push({ student: student.user, institution: institution._id, title: `${program.name} Tuition - Installment ${number}/${program.installments}`, feeType: 'tuition', amount, currency: program.currency, dueDate, installment: { planId, number, totalInstallments: program.installments }, recordedBy: req.user._id });
      }
      await Fee.insertMany(feeRows);
    }
  }
  return created(res, program, `Program and fee plan created${students.length ? ` and assigned to ${students.length} existing student(s)` : ''}.`);
});

const listPrograms = asyncHandler(async (req, res) => {
  const programs = await InstitutionProgram.find({ institution: req.params.id, active: true }).populate('classSection', 'name academicYear').sort({ name: 1 });
  return ok(res, programs);
});

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

// GET /api/institutions/admin/all (admin/platform_staff â€” every status, for verification review)
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

// No account type can act on the platform until Super Admin has approved it â€” an unverified
// (potentially fake) institution must not be able to hire staff, charge fees, issue certificates,
// broadcast notifications, etc. Setup/editing basic details and submitting verification documents
// stay allowed (updateInstitution, submitVerificationDocuments) since those are how an owner
// actually reaches verification in the first place; everything that acts on real people or money
// is gated here.
function assertInstitutionVerified(institution) {
  if (institution.verificationStatus !== 'approved') {
    throw new AppError('This institution must be verified by Super Admin before it can do this.', 403);
  }
}

// PATCH /api/institutions/:id
const updateInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const allowed = ['name', 'city', 'address', 'description', 'contactEmail', 'contactPhone', 'website', 'logo', 'coverImage', 'admissionRequirements', 'admissionDeadline'];
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

  notifyAdmins({
    title: `New institution verification request: ${institution.name}`,
    body: `${req.user.fullName} (${req.user.email}) submitted ${documents.length} document(s) for "${institution.name}". Please review before it can go live.`
  }).catch(() => {});

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

  // The owner's own "institution_owner"/"academy_owner" role request (from signup or /roles/
  // request) is a separate, older approval trail that duplicates this one â€” an owner should only
  // ever have to clear ONE approval, not two out-of-sync ones. Verifying the institution here is
  // the real vetting, so mirror the same decision onto that role request instead of leaving it
  // permanently pending (which would otherwise still show a stale "dashboard unlocked but posting
  // locked" banner even after the institution itself is approved).
  await RoleRequest.updateMany(
    { user: institution.owner, requestedRole: { $in: ['institution_owner', 'academy_owner'] }, status: { $in: ['pending', 'under_review'] } },
    { $set: { status: decision, reviewedBy: req.user._id, reviewedAt: new Date(), reviewNotes: `Auto-synced from ${institution.name} verification.` } }
  );

  const owner = await User.findById(institution.owner).select('fullName email');
  if (owner) {
    const body = decision === 'approved'
      ? `Congratulations! "${institution.name}" has been verified and approved. Your institution is now live and visible to students, parents and teachers on CareerZ.${notes ? `\n\nAdmin notes: ${notes}` : ''}`
      : `Your institution "${institution.name}" verification was rejected.${notes ? `\n\nReason: ${notes}` : ' Please review your submitted documents and resubmit.'}`;
    notify(owner._id, {
      title: `Institution verification ${decision}: ${institution.name}`,
      body,
      sentBy: req.user._id
    }, { email: true, toAddress: owner.email }).catch(() => {});
  }

  return ok(res, institution, `Institution verification ${decision}.`);
});

// POST /api/institutions/:id/staff
const addStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);
  assertInstitutionVerified(institution);

  const { userId, role, permissions, department, designation } = req.body;
  if (!userId || !role) throw new AppError('userId and role are required.', 422);

  const alreadyStaff = institution.staff.some((s) => s.user.toString() === userId);
  if (alreadyStaff) throw new AppError('User is already staff at this institution.', 409);
  await assertStaffCapAllows(institution, institution.staff.length);

  await onboardStaff(institution, userId, { role, department, designation, permissions });
  return ok(res, institution, 'Staff member added.');
});

// DELETE /api/institutions/:id/staff/:userId
const removeStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);

  await offboardStaff(institution, req.params.userId);
  return ok(res, institution, 'Staff member removed.');
});

// PATCH /api/institutions/:id/staff/:userId/ai-permissions â€” owner-only toggle for whether a
// staff member may use ('ai:use') and/or connect/manage ('ai:manage') the institution's own
// AI keys. Matches the frontend's Staff Management panel, which already calls this endpoint.
const updateStaffAiPermissions = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff AI permissions.', 403);
  assertInstitutionVerified(institution);

  const staffEntry = institution.staff.find((s) => s.user.toString() === req.params.userId);
  if (!staffEntry) throw new AppError('Staff member not found.', 404);

  const { canUseAi, canManageAi } = req.body;
  const permissions = new Set(staffEntry.permissions || []);
  permissions.delete('ai:use');
  permissions.delete('ai:manage');
  // Managing keys implies being able to use them.
  if (canUseAi || canManageAi) permissions.add('ai:use');
  if (canManageAi) permissions.add('ai:manage');
  staffEntry.permissions = Array.from(permissions);
  await institution.save();

  return ok(res, institution, 'Staff AI permissions updated.');
});

// GET /api/institutions/:id/staff-attendance â€” owner/staff view of everyone's real self-check-ins
// (spec 15D.9). Populated from the same StaffAttendance records teachers create themselves.
const listStaffAttendance = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const records = await StaffAttendance.find({ institution: institution._id })
    .populate('staff', 'fullName profilePhoto')
    .sort({ date: -1 })
    .limit(200);
  return ok(res, records);
});

// ---- Virtual Campus Tour (real 3D map, built from the institution's own building data) ----

// GET /api/institutions/:id/campus-buildings â€” public: anyone (student, parent, prospective
// applicant) can view the tour without being staff, same as browsing the institution's profile.
const listCampusBuildings = asyncHandler(async (req, res) => {
  const buildings = await CampusBuilding.find({ institution: req.params.id }).sort({ order: 1, createdAt: 1 });
  return ok(res, buildings);
});

const createCampusBuilding = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const { name, type, color, positionX, positionZ, width, depth, floors, description, photo } = req.body;
  if (!name) throw new AppError('Building name is required.', 422);

  const building = await CampusBuilding.create({
    institution: institution._id, name, type, color, positionX, positionZ, width, depth, floors, description, photo
  });
  return created(res, building, 'Building added to the campus tour.');
});

const updateCampusBuilding = asyncHandler(async (req, res) => {
  const building = await CampusBuilding.findById(req.params.buildingId);
  if (!building) throw new AppError('Building not found.', 404);
  const institution = await Institution.findById(building.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const allowed = ['name', 'type', 'color', 'positionX', 'positionZ', 'width', 'depth', 'floors', 'description', 'photo', 'order'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) building[f] = req.body[f]; });
  await building.save();
  return ok(res, building, 'Building updated.');
});

const deleteCampusBuilding = asyncHandler(async (req, res) => {
  const building = await CampusBuilding.findById(req.params.buildingId);
  if (!building) throw new AppError('Building not found.', 404);
  const institution = await Institution.findById(building.institution);
  assertOwnerOrStaff(institution, req.user._id);

  await building.deleteOne();
  return ok(res, null, 'Building removed.');
});

// ---- Campuses ----
const createCampus = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

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
  assertInstitutionVerified(institution);

  const section = await ClassSection.create({ institution: institution._id, ...req.body });
  return created(res, section);
});

const listClassSections = asyncHandler(async (req, res) => {
  const sections = await ClassSection.find({ institution: req.params.id }).populate('classTeacher', 'fullName email');
  return ok(res, sections);
});

// PATCH /api/institutions/:id/class-sections/:sectionId â€” mainly for assigning/changing the class teacher
const updateClassSection = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const allowed = ['name', 'academicYear', 'classTeacher'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f] || null; });

  const section = await ClassSection.findOneAndUpdate(
    { _id: req.params.sectionId, institution: institution._id },
    { $set: update },
    { new: true }
  ).populate('classTeacher', 'fullName email');
  if (!section) throw new AppError('Class section not found.', 404);

  return ok(res, section, 'Class section updated.');
});

// ---- Fees ----
const createFee = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const { student, title, feeType, amount, currency, dueDate, installments } = req.body;
  if (!student || !title || amount === undefined) {
    throw new AppError('student, title and amount are required.', 422);
  }

  const feeStudent = await User.findById(student).select('fullName');
  if (!feeStudent) throw new AppError('Student not found.', 404);
  const belongsToInstitution = await StudentProfile.exists({ user: student, primaryInstitution: institution._id });
  if (!belongsToInstitution) throw new AppError('Select an enrolled student from this institution.', 422);

  // Instalment plan: split `amount` into N equal parts, each its own Fee doc sharing a planId,
  // so the parent/student sees "Instalment 1 of 3" etc. and can pay them one at a time.
  const n = Number(installments) || 1;
  if (n > 1) {
    const planId = crypto.randomBytes(6).toString('hex');
    let allocated = 0;
    const fees = await Promise.all(Array.from({ length: n }, (_, i) => {
      const per = i === n - 1 ? Math.round((Number(amount) - allocated) * 100) / 100 : Math.round((Number(amount) / n) * 100) / 100;
      allocated += per;
      const due = dueDate ? new Date(dueDate) : null;
      if (due) due.setMonth(due.getMonth() + i);
      return Fee.create({
        student, institution: institution._id, title: `${title} (Instalment ${i + 1}/${n})`,
        feeType: feeType || 'other', amount: per, currency: currency || 'USD', dueDate: due,
        installment: { planId, number: i + 1, totalInstallments: n }, recordedBy: req.user._id
      });
    }));
    await notifyParentsOfStudent(student, {
      title: `New fee plan for ${feeStudent?.fullName || 'your child'}`,
      body: `${title}: ${currency || 'USD'} ${amount} in ${n} instalments`,
      sentBy: req.user._id
    }).catch(() => {});
    return created(res, fees, `Fee recorded in ${n} instalments.`);
  }

  const fee = await Fee.create({
    student,
    institution: institution._id,
    title,
    feeType: feeType || 'other',
    amount,
    currency: currency || 'USD',
    dueDate: dueDate || null,
    recordedBy: req.user._id
  });

  await notifyParentsOfStudent(student, {
    title: `New fee due for ${feeStudent?.fullName || 'your child'}`,
    body: `${title}: ${currency || 'USD'} ${amount}${dueDate ? ` â€” due ${new Date(dueDate).toLocaleDateString()}` : ''}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, fee, 'Fee recorded.');
});

// POST /api/institutions/fees/:feeId/remind â€” manual trigger for the "Automatic Reminder"
// (spec 15D.7). No cron/scheduler exists in this codebase (same honest pattern as meeting
// reminders elsewhere), so reminders are sent on-demand by the institution, or lazily whenever
// listFees runs past the due date â€” see the auto-reminder check below.
const remindFee = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId).populate('student', 'fullName');
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);
  if (fee.status === 'paid') throw new AppError('This fee is already paid.', 400);

  await notifyParentsOfStudent(fee.student._id, {
    title: `Fee reminder: ${fee.title}`,
    body: `${fee.currency} ${fee.amount} due${fee.dueDate ? ` on ${new Date(fee.dueDate).toLocaleDateString()}` : ''}. Please pay soon.`,
    sentBy: req.user._id
  }, { email: false }).catch(() => {});
  fee.reminderSentAt = new Date();
  await fee.save();

  return ok(res, fee, 'Reminder sent.');
});

// POST /api/institutions/fees/:feeId/refund/request â€” student/parent requests a refund.
const requestFeeRefund = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  if (fee.status !== 'paid') throw new AppError('Only a paid fee can be refunded.', 400);

  const isStudent = fee.student.toString() === req.user._id.toString();
  if (!isStudent) {
    const isLinkedParent = await ParentChildLink.exists({ parent: req.user._id, student: fee.student, status: 'approved' });
    const institution = await Institution.findById(fee.institution);
    const isStaff = institution && (institution.owner.toString() === req.user._id.toString() || institution.staff.some((s) => s.user.toString() === req.user._id.toString()));
    if (!isLinkedParent && !isStaff) throw new AppError('You are not authorized to request a refund for this fee.', 403);
  }

  const { reason } = req.body;
  fee.refund = { status: 'requested', reason: reason || '', amount: fee.amount, requestedAt: new Date(), processedAt: null, processedBy: null };
  await fee.save();

  const institution = await Institution.findById(fee.institution);
  const recipients = [institution.owner, ...institution.staff.map((s) => s.user)];
  await Promise.all(recipients.map((id) => notify(id, {
    title: `Refund requested: ${fee.title}`,
    body: reason || '',
    sentBy: req.user._id
  }).catch(() => {})));

  return ok(res, fee, 'Refund requested.');
});

// PATCH /api/institutions/fees/:feeId/refund/decide â€” institution approves/rejects/processes a refund.
const decideFeeRefund = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);
  const institution = await Institution.findById(fee.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const { decision } = req.body; // 'approved' | 'rejected' | 'refunded'
  if (!['approved', 'rejected', 'refunded'].includes(decision)) throw new AppError('decision must be approved, rejected or refunded.', 422);
  if (fee.refund.status !== 'requested' && !(decision === 'refunded' && fee.refund.status === 'approved')) {
    throw new AppError('This refund is not in a state that allows that decision.', 400);
  }

  fee.refund.status = decision;
  fee.refund.processedAt = new Date();
  fee.refund.processedBy = req.user._id;
  if (decision === 'refunded') fee.status = 'refunded';
  await fee.save();

  await notify(fee.student, {
    title: `Refund ${decision}: ${fee.title}`,
    body: `${fee.currency} ${fee.refund.amount}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, fee, `Refund ${decision}.`);
});

const listFees = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const { sweepOverdueAndLateFees, sweepReminders, autoGenerateDueInvoices } = require('../utils/feeSchedule');
  await autoGenerateDueInvoices(institution._id).then(() => sweepOverdueAndLateFees(institution._id)).then(() => sweepReminders(institution._id)).catch(() => {});

  const fees = await Fee.find({ institution: institution._id }).populate('student', 'fullName email').sort({ createdAt: -1 });
  return ok(res, fees);
});

  const markFeePaid = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);

  const institution = await Institution.findById(fee.institution);
    const isOwner = assertOwnerOrStaff(institution, req.user._id);
    if (!isOwner && !institution.staff.some((staff) => staff.user.toString() === req.user._id.toString()
      && staff.permissions.includes('fee:manage'))) {
      throw new AppError('Fee management permission is required.', 403);
    }
    assertInstitutionVerified(institution);
    if (fee.status === 'paid') throw new AppError('Fee is already paid.', 409);

    const { paidVia, reference } = req.body;
    if (!paidVia || /card|stripe|paddle|jazzcash|nowpayments/i.test(paidVia)) {
      throw new AppError('Specify a verified manual payment method; online payments require gateway confirmation.', 422);
    }
    if (!String(reference || '').trim()) throw new AppError('Cash receipt/reference number is required.', 422);
  const receipt = await computeReceiptAmounts(fee.amount, FEE_COMMISSION_KEY);
  fee.status = 'paid';
  fee.paidAt = new Date();
  fee.paidVia = paidVia || '';
  fee.grossAmount = receipt.grossAmount;
  fee.platformCommission = receipt.platformCommission;
  fee.gatewayCharges = receipt.gatewayCharges;
  fee.taxAmount = receipt.taxAmount;
  fee.netAmount = receipt.netAmount;
  fee.escrowStatus = 'held';
  fee.receiptNumber = `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  if (!fee.verifyCode) fee.verifyCode = crypto.randomBytes(10).toString('hex');
  // Offline/cash collection still creates a real, immutable payment-history entry and audit trail
  // — it never just overwrites the invoice total with no record of who recorded it or how.
  fee.paymentHistory.push({ amount: fee.outstandingAmount ?? fee.amount, method: paidVia, transactionId: String(reference).trim(), reference: String(reference).trim(), verificationStatus: 'verified', recordedBy: req.user._id, verifiedBy: req.user._id, verifiedAt: new Date() });
  fee.paidAmount = fee.amount;
  fee.outstandingAmount = 0;
  fee.restrictionActive = false;
  await fee.save();

  return ok(res, fee, 'Fee marked as paid.');
});

// PATCH /api/institutions/fees/:feeId/release â€” escrow release (spec 3A.3): the institution
// confirms the paid fee and moves it out of "held" into "released" (available to them). No real
// fund custody happens anywhere in this app (no payment gateway connected) â€” see Fee.js's
// escrowStatus comment for what this status machine does and does not represent.
const releaseFeeEscrow = asyncHandler(async (req, res) => {
  const fee = await Fee.findById(req.params.feeId);
  if (!fee) throw new AppError('Fee record not found.', 404);

  const institution = await Institution.findById(fee.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  if (fee.status !== 'paid') throw new AppError('Only a paid fee can be released.', 400);
  if (fee.escrowStatus === 'released') throw new AppError('This fee has already been released.', 400);
  if (fee.escrowStatus !== 'held') throw new AppError('This fee has no held funds to release.', 400);

  fee.escrowStatus = 'released';
  fee.escrowReleasedAt = new Date();
  fee.escrowReleasedBy = req.user._id;
  await fee.save();

  return ok(res, fee, 'Escrow released.');
});

// ---- Timetable ----
const createTimetableEntry = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const section = await ClassSection.findById(req.params.sectionId);
  if (!section || section.institution.toString() !== institution._id.toString()) {
    throw new AppError('Class section not found for this institution.', 404);
  }

  const { teacher, course, subject, dayOfWeek, startTime, endTime, room, meetingLink } = req.body;
  if (!course || !teacher || !dayOfWeek || !startTime || !endTime) {
    throw new AppError('course, teacher, dayOfWeek, startTime and endTime are required.', 422);
  }
  const courseDoc = await Course.findOne({ _id: course, institution: institution._id, classSection: section._id, teacher });
  if (!courseDoc) throw new AppError('Select a course assigned to this section and teacher.', 422);

  const entry = await TimetableEntry.create({
    institution: institution._id,
    classSection: section._id,
    teacher: teacher || null,
    course: courseDoc._id,
    subject: courseDoc.title || subject,
    dayOfWeek,
    startTime,
    endTime,
    room: room || '',
    meetingLink: meetingLink || '',
    createdBy: req.user._id
  });

  if (entry.teacher) {
    await notify(entry.teacher, {
      title: `New class scheduled: ${subject}`,
      body: `${DOW_FULL[dayOfWeek] || dayOfWeek} ${startTime}â€“${endTime}${room ? ` Â· ${room}` : ''}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return created(res, entry, 'Timetable entry added.');
});

const listTimetable = asyncHandler(async (req, res) => {
  const entries = await TimetableEntry.find({ classSection: req.params.sectionId })
    .populate('teacher', 'fullName email')
    .populate('course', 'title subject')
    .populate('classSection', 'name academicYear')
    .sort({ dayOfWeek: 1, startTime: 1 });
  return ok(res, entries);
});

// PATCH /api/institutions/:id/class-sections/:sectionId/timetable/:entryId â€” the actual
// "Class change" event (editing an existing scheduled class, not just adding/removing one).
const updateTimetableEntry = asyncHandler(async (req, res) => {
  const entry = await TimetableEntry.findById(req.params.entryId);
  if (!entry) throw new AppError('Timetable entry not found.', 404);

  const institution = await Institution.findById(entry.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  if (req.body.course || req.body.teacher) {
    const courseId = req.body.course || entry.course;
    const teacherId = req.body.teacher || entry.teacher;
    const courseDoc = await Course.findOne({ _id: courseId, institution: institution._id, classSection: entry.classSection, teacher: teacherId });
    if (!courseDoc) throw new AppError('Select a course assigned to this section and teacher.', 422);
    entry.course = courseDoc._id;
    entry.teacher = teacherId;
    entry.subject = courseDoc.title;
  }
  const allowed = ['dayOfWeek', 'startTime', 'endTime', 'room', 'meetingLink'];
  const previousTeacher = entry.teacher;
  allowed.forEach((f) => { if (req.body[f] !== undefined) entry[f] = req.body[f] || (f === 'teacher' ? null : ''); });
  await entry.save();

  const notifyTeacherId = entry.teacher || previousTeacher;
  if (notifyTeacherId) {
    await notify(notifyTeacherId, {
      title: `Class changed: ${entry.subject}`,
      body: `${DOW_FULL[entry.dayOfWeek] || entry.dayOfWeek} ${entry.startTime}â€“${entry.endTime}${entry.room ? ` Â· ${entry.room}` : ''}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, entry, 'Timetable entry updated.');
});

const deleteTimetableEntry = asyncHandler(async (req, res) => {
  const entry = await TimetableEntry.findById(req.params.entryId);
  if (!entry) throw new AppError('Timetable entry not found.', 404);

  const institution = await Institution.findById(entry.institution);
  assertOwnerOrStaff(institution, req.user._id);

  if (entry.teacher) {
    await notify(entry.teacher, {
      title: `Class cancelled: ${entry.subject}`,
      body: `${DOW_FULL[entry.dayOfWeek] || entry.dayOfWeek} ${entry.startTime}â€“${entry.endTime}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  await entry.deleteOne();
  return ok(res, { deleted: true }, 'Timetable entry removed.');
});

// ---- Teacher / Student Management ----
const listInstitutionCourses = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const courses = await Course.find({ institution: institution._id })
    .populate('teacher', 'fullName email')
    .populate('classSection', 'name academicYear')
    .sort({ title: 1 });
  return ok(res, courses);
});

const assignCourseAcademics = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const course = await Course.findOne({ _id: req.params.courseId, institution: institution._id });
  if (!course) throw new AppError('Course not found for this institution.', 404);
  const { subject, classSection, teacher, creditHours, academicTerm } = req.body;
  if (!String(subject || '').trim() || !classSection || !teacher) throw new AppError('Subject, class section and teacher are required.', 422);
  const section = await ClassSection.findOne({ _id: classSection, institution: institution._id });
  if (!section) throw new AppError('Select a class section from this institution.', 422);
  const teacherLinked = await TeacherProfile.exists({ user: teacher, institutions: institution._id });
  if (!teacherLinked) throw new AppError('Select a teacher linked to this institution.', 422);
  course.subject = String(subject).trim();
  course.classSection = section._id;
  course.teacher = teacher;
  course.creditHours = Number(creditHours) || 3;
  course.academicTerm = String(academicTerm || '').trim();
  await course.save();
  await notify(teacher, { title: `Course assigned: ${course.title}`, body: `${course.subject} Â· ${section.name} Â· ${section.academicYear || 'Academic session not set'}`, sentBy: req.user._id }).catch(() => {});
  await course.populate([{ path: 'teacher', select: 'fullName email' }, { path: 'classSection', select: 'name academicYear' }]);
  return ok(res, course, 'Course academic assignment updated.');
});

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

  const memberIds = await StudentInstitutionMembership.find({ institution: institution._id, status: 'active' }).distinct('student');
  const students = await StudentProfile.find({ user: { $in: memberIds } })
    .populate('user', 'fullName email')
    .populate('classSection', 'name')
    .sort({ createdAt: -1 });
  return ok(res, students);
});

// GET /api/institutions/:id/parents â€” a real parent directory (spec: Institution<->Parent
// "parent directory relationship"): every parent with an approved link to one of this
// institution's students, which of their children are here, and whether the institution has
// separately verified that link.
const listInstitutionParents = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const studentIds = await StudentProfile.find({ primaryInstitution: institution._id }).distinct('user');
  const links = await ParentChildLink.find({ student: { $in: studentIds }, status: 'approved' })
    .populate('parent', 'fullName email phone')
    .populate('student', 'fullName')
    .sort({ createdAt: -1 });

  const byParent = new Map();
  for (const link of links) {
    if (!link.parent) continue;
    const key = link.parent._id.toString();
    if (!byParent.has(key)) {
      byParent.set(key, { parent: link.parent, children: [] });
    }
    byParent.get(key).children.push({
      linkId: link._id, name: link.student?.fullName, relationship: link.relationship,
      institutionVerified: link.institutionVerified
    });
  }

  return ok(res, Array.from(byParent.values()));
});

// PATCH /api/institutions/:id/parents/:linkId/verify â€” institution's own extra confirmation on
// top of student consent (spec: "guardian verification").
const verifyParentLink = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const link = await ParentChildLink.findById(req.params.linkId);
  if (!link || link.status !== 'approved') throw new AppError('Parent-child link not found.', 404);
  const studentBelongsHere = await StudentProfile.exists({ user: link.student, primaryInstitution: institution._id });
  if (!studentBelongsHere) throw new AppError('That link is not for one of this institution\'s students.', 403);

  link.institutionVerified = req.body.verified !== false;
  link.institutionVerifiedBy = req.user._id;
  link.institutionVerifiedAt = new Date();
  await link.save();
  return ok(res, link, link.institutionVerified ? 'Guardian link verified.' : 'Guardian verification removed.');
});

// GET /api/institutions/:id/feedback â€” parent satisfaction ratings received (spec:
// Institution<->Parent "parent satisfaction/feedback", "parent engagement analytics").
const getInstitutionFeedback = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const InstitutionFeedback = require('../models/InstitutionFeedback');
  const [entries, agg] = await Promise.all([
    InstitutionFeedback.find({ institution: institution._id }).populate('fromUser', 'fullName').sort({ createdAt: -1 }),
    InstitutionFeedback.aggregate([{ $match: { institution: institution._id } }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }])
  ]);
  return ok(res, {
    average: agg[0] ? Math.round(agg[0].average * 10) / 10 : null,
    count: agg[0]?.count || 0,
    entries
  });
});

// GET /api/institutions/:id/feedback/summary â€” average + count only (no comments), visible to
// any authenticated user (e.g. a parent deciding whether/how to rate), plus their own rating if
// they've already left one.
const getInstitutionFeedbackSummary = asyncHandler(async (req, res) => {
  const InstitutionFeedback = require('../models/InstitutionFeedback');
  const [agg, mine] = await Promise.all([
    InstitutionFeedback.aggregate([{ $match: { institution: new mongoose.Types.ObjectId(req.params.id) } }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
    InstitutionFeedback.findOne({ institution: req.params.id, fromUser: req.user._id })
  ]);
  return ok(res, {
    average: agg[0] ? Math.round(agg[0].average * 10) / 10 : null,
    count: agg[0]?.count || 0,
    myRating: mine?.rating || null,
    myComment: mine?.comment || ''
  });
});

const updateStudentStatus = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findById(req.params.profileId);
  if (!profile) throw new AppError('Student profile not found.', 404);

  const institution = await Institution.findById(profile.primaryInstitution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const { status, classSection, rollNumber, reason } = req.body;
  if (status !== undefined) {
    if (!['active', 'suspended', 'graduated', 'transferred'].includes(status)) {
      throw new AppError('Invalid status.', 422);
    }
    profile.status = status;
    // A real transfer/history record (spec: "transfer/withdrawal/alumni lifecycle") â€” not just
    // an overwritten status flag. 'suspended'/'active' aren't a departure, so only these two are.
    if (['transferred', 'graduated'].includes(status)) {
      await recordLeave(profile.user, institution._id, status, reason);
    }
  }
  // Class Section + Roll Number are normally assigned by the institution's office, not the
  // student â€” this is the school-admin side of that assignment.
  if (classSection !== undefined) profile.classSection = classSection || null;
  if (rollNumber !== undefined) profile.rollNumber = rollNumber;
  await profile.save();
  const refreshed = await StudentProfile.findById(profile._id).populate('primaryInstitution', 'name');
  return ok(res, refreshed, 'Student record updated.');
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
const listMembershipRequests = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const requests = await StudentInstitutionMembership.find({ institution: institution._id, status: { $in: ['pending', 'withdrawal_requested', 'transfer_requested'] } })
    .populate('student', 'fullName email profilePhoto').populate('targetInstitution', 'name').sort({ updatedAt: 1 });
  return ok(res, requests);
});

const reviewMembershipRequest = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const { decision } = req.body;
  if (!['approve', 'reject'].includes(decision)) throw new AppError('decision must be approve or reject.', 422);
  const membership = await StudentInstitutionMembership.findOne({ _id: req.params.membershipId, institution: institution._id }).populate('student', 'fullName');
  if (!membership || !['pending', 'withdrawal_requested', 'transfer_requested'].includes(membership.status)) throw new AppError('Pending membership request not found.', 404);
  const previousStatus = membership.status;
  if (decision === 'reject') {
    membership.status = previousStatus === 'pending' ? 'rejected' : 'active'; membership.requestedAction = ''; membership.targetInstitution = null;
    membership.reviewedBy = req.user._id; membership.reviewedAt = new Date(); await membership.save();
  } else if (previousStatus === 'pending') {
    // A minor joining an institution needs an approved guardian on record first — same consent
    // rule already enforced for independent-tutoring links (teacherStudentLink.controller.js);
    // an unknown date of birth is treated conservatively as a minor.
    const studentProfile = await StudentProfile.findOne({ user: membership.student._id });
    const age = studentProfile?.dateOfBirth
      ? Math.floor((Date.now() - new Date(studentProfile.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : null;
    if (age === null || age < 18) {
      const hasConsentingGuardian = await ParentChildLink.exists({ student: membership.student._id, status: 'approved', 'permissions.giveConsent': true });
      if (!hasConsentingGuardian) {
        throw new AppError('This student appears to be a minor — a parent/guardian must be linked and approved (with consent permission) before this institution join can be approved.', 422);
      }
    }
    await recordJoin(membership.student._id, institution._id, membership.program);
    membership.status = 'active'; membership.requestedAction = ''; membership.reviewedBy = req.user._id; membership.reviewedAt = new Date(); await membership.save();
  } else {
    const finalStatus = previousStatus === 'transfer_requested' ? 'transferred' : 'withdrawn';
    const targetInstitution = membership.targetInstitution;
    await recordLeave(membership.student._id, institution._id, finalStatus, membership.reason);
    membership.reviewedBy = req.user._id; membership.reviewedAt = new Date(); await membership.save();
    if (targetInstitution) {
      await StudentInstitutionMembership.findOneAndUpdate(
        { student: membership.student._id, institution: targetInstitution },
        { $set: { status: 'pending', requestedAction: 'join', reason: `Transfer from ${institution.name}`, targetInstitution: null, reviewedBy: null, reviewedAt: null } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      const target = await Institution.findById(targetInstitution);
      if (target) await notify(target.owner, { title: `Incoming transfer request: ${membership.student.fullName}`, sentBy: req.user._id }).catch(() => {});
    }
  }
  await notify(membership.student._id, { title: `${institution.name} ${decision}d your ${membership.requestedAction || (previousStatus === 'pending' ? 'join' : 'exit')} request`, sentBy: req.user._id }, { email: true }).catch(() => {});
  return ok(res, membership, `Membership request ${decision}d.`);
});

const createPayslip = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  const { staff, month, year, basicSalary, bonuses, overtimeAmount, allowances, commissionAmount, deductions, taxAmount, currency } = req.body;
  if (!staff || !month || !year || basicSalary === undefined) {
    throw new AppError('staff, month, year and basicSalary are required.', 422);
  }

  const staffEntry = institution.staff.find((entry) => entry.user.toString() === String(staff));
  if (!staffEntry) throw new AppError('The selected person is not active staff at this institution.', 403);
  const amounts = [basicSalary, bonuses || 0, overtimeAmount || 0, allowances || 0, commissionAmount || 0, deductions || 0, taxAmount || 0].map(Number);
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) throw new AppError('Salary amounts must be valid non-negative numbers.', 422);
  const existingPayslip = await Payslip.findOne({ institution: institution._id, staff, month: Number(month), year: Number(year) });
  if (existingPayslip) throw new AppError('A payslip for this employee and month already exists.', 409);
  const netAmount = amounts[0] + amounts[1] + amounts[2] + amounts[3] + amounts[4] - amounts[5] - amounts[6];
  if (netAmount < 0) throw new AppError('Deductions cannot exceed gross salary.', 422);
  const payslip = await Payslip.create({
    institution: institution._id,
    staff,
    month,
    year,
    basicSalary,
    bonuses: bonuses || 0,
    overtimeAmount: overtimeAmount || 0,
    allowances: allowances || 0,
    commissionAmount: commissionAmount || 0,
    deductions: deductions || 0,
    taxAmount: taxAmount || 0,
    netAmount,
    currency: currency || 'USD',
    generatedBy: req.user._id
  });

  await notify(staff, { title: `New salary slip: ${payslip.currency} ${payslip.netAmount}`, body: `${payslip.month}/${payslip.year} — ${institution.name}`, sentBy: req.user._id }).catch(() => {});
  return created(res, payslip, 'Payslip generated.');
});

// Real "sales" basis for commission: paid CoursePurchase revenue on courses this teacher owns,
// inside the given calendar month. Kept separate from Fee (institution tuition, not tied to a
// specific teacher's course) so commission is never computed from money that isn't actually this
// teacher's to earn a cut of.
async function computeCourseCommission(teacherId, institutionId, commissionPercent, month, year) {
  if (!commissionPercent) return 0;
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 1);
  const teacherCourseIds = await Course.find({ teacher: teacherId, institution: institutionId }).distinct('_id');
  if (teacherCourseIds.length === 0) return 0;
  const purchases = await CoursePurchase.find({ course: { $in: teacherCourseIds }, status: 'paid', paidAt: { $gte: monthStart, $lt: monthEnd } });
  const revenue = purchases.reduce((sum, p) => sum + p.amountMinor / 100, 0);
  return Math.round(revenue * (commissionPercent / 100) * 100) / 100;
}

// Shared by the manual "Generate Monthly Payroll" button AND the lazy auto-trigger below —
// idempotent (skips any staff member who already has a payslip for that month/year), same as
// every other "no cron in this app" lazy-scheduled job (see job/scholarship reminder comments).
async function runMonthlyPayrollFor(institution, month, year, generatedBy) {
  const employments = await TeacherEmployment.find({ institution: institution._id, status: 'active', salaryType: { $in: ['monthly', 'hybrid', 'commission'] } });
  let createdCount = 0; let skippedCount = 0;
  for (const employment of employments) {
    const hasMonthly = ['monthly', 'hybrid'].includes(employment.salaryType) && employment.monthlySalary > 0;
    const hasCommission = ['commission', 'hybrid'].includes(employment.salaryType) && employment.commissionPercent > 0;
    if (!hasMonthly && !hasCommission) { skippedCount += 1; continue; }
    const exists = await Payslip.exists({ institution: institution._id, staff: employment.teacher, month, year });
    if (exists) { skippedCount += 1; continue; }

    const basicSalary = hasMonthly ? Number(employment.monthlySalary || 0) : 0;
    const commissionAmount = hasCommission
      ? await computeCourseCommission(employment.teacher, institution._id, employment.commissionPercent, month, year)
      : 0;
    const gross = basicSalary + commissionAmount;
    const taxAmount = Math.round((gross * Number(employment.taxPercent || 0) / 100) * 100) / 100;
    await Payslip.create({ institution: institution._id, staff: employment.teacher, month, year, basicSalary, commissionAmount, taxAmount, netAmount: gross - taxAmount, currency: employment.salaryCurrency || 'PKR', generatedBy });
    await notify(employment.teacher, { title: `New salary slip: ${employment.salaryCurrency || 'PKR'} ${gross - taxAmount}`, body: `${month}/${year} — ${institution.name}`, sentBy: generatedBy }, { email: true }).catch(() => {});
    createdCount += 1;
  }
  return { created: createdCount, skipped: skippedCount, eligible: employments.length };
}

const generateMonthlyPayroll = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);
  const month = Number(req.body.month); const year = Number(req.body.year);
  if (month < 1 || month > 12 || year < 2000) throw new AppError('A valid month and year are required.', 422);
  const result = await runMonthlyPayrollFor(institution, month, year, req.user._id);
  return created(res, result, 'Monthly payroll generated.');
});

// "Automatic" monthly payroll — runs at most once per real calendar-month rollover per
// institution. Two trigger paths now call this: (1) lazily, the first time any owner/staff loads
// the Payroll screen that month, and (2) the real background scheduler (see
// services/feeAutomation.service.js), so payroll no longer depends on anyone actually opening
// that page — it generates on its own calendar exactly like fee invoices do.
async function autoRunPreviousMonthPayrollIfDue(institution, actingUserId) {
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = prevMonthDate.getMonth() + 1;
  const year = prevMonthDate.getFullYear();
  try {
    await runMonthlyPayrollFor(institution, month, year, actingUserId);
  } catch (error) {
    // Best-effort — a manual "Generate Monthly Payroll" click always remains available — but the
    // failure is no longer silently swallowed with zero trace (spec gap: "errors silently ignore").
    console.error(`[PAYROLL AUTOMATION] institution=${institution._id} ${month}/${year}`, error);
  }
}

// Background-scheduler entry point (bare institutionId, no request context) — mirrors
// utils/feeSchedule.js's autoGenerateDueInvoices shape so feeAutomation.service.js can drive both
// the same way.
async function runPayrollAutomationForInstitution(institutionId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) return;
  await autoRunPreviousMonthPayrollIfDue(institution, institution.owner);
}

const getPayrollTaxReport = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const year = Number(req.query.year || new Date().getFullYear());
  const rows = await Payslip.find({ institution: institution._id, year }).populate('staff', 'fullName email').sort({ month: 1 });
  const totals = rows.reduce((sum, row) => ({ gross: sum.gross + row.basicSalary + row.bonuses + row.overtimeAmount + row.allowances + (row.commissionAmount || 0), tax: sum.tax + (row.taxAmount || 0), deductions: sum.deductions + row.deductions, net: sum.net + row.netAmount }), { gross: 0, tax: 0, deductions: 0, net: 0 });
  return ok(res, { year, totals, rows });
});

const listInstitutionPayroll = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  await autoRunPreviousMonthPayrollIfDue(institution, req.user._id);

  const payslips = await Payslip.find({ institution: institution._id })
    .populate('staff', 'fullName email')
    .sort({ year: -1, month: -1 });
  return ok(res, payslips);
});

const PAYSLIP_METHOD_LABEL = { ...PAYOUT_METHOD_LABEL, cash: 'Cash', platform_wallet: 'CareerZ Wallet' };

const getMyPayoutProfile = asyncHandler(async (req, res) => {
  const profile = await PayoutProfile.findOne({ user: req.user._id }).lean();
  return ok(res, profile || { user: req.user._id, preferredMethod: 'platform_wallet', bank: {}, mobileWallet: {}, crypto: {} });
});

const saveMyPayoutProfile = asyncHandler(async (req, res) => {
  const allowed = ['platform_wallet', 'bank_transfer', 'mobile_wallet', 'crypto', 'cash'];
  const preferredMethod = String(req.body.preferredMethod || 'platform_wallet');
  if (!allowed.includes(preferredMethod)) throw new AppError('Invalid preferred payout method.', 422);
  const clean = (value) => String(value || '').trim();
  const profile = await PayoutProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: {
      preferredMethod,
      bank: { accountTitle: clean(req.body.bank?.accountTitle), bankName: clean(req.body.bank?.bankName), iban: clean(req.body.bank?.iban), accountNumber: clean(req.body.bank?.accountNumber) },
      mobileWallet: { provider: clean(req.body.mobileWallet?.provider), accountTitle: clean(req.body.mobileWallet?.accountTitle), number: clean(req.body.mobileWallet?.number) },
      crypto: { asset: clean(req.body.crypto?.asset), network: clean(req.body.crypto?.network), address: clean(req.body.crypto?.address) }
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return ok(res, profile, 'Salary payout details saved.');
});

function maskAccount(value) {
  const text = String(value || '');
  return text ? `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}` : '';
}

const getStaffPayoutProfile = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  if (!institution.staff.some((entry) => entry.user.toString() === req.params.userId)) throw new AppError('This user is not institution staff.', 403);
  const profile = await PayoutProfile.findOne({ user: req.params.userId }).lean();
  if (!profile) return ok(res, { configured: false, preferredMethod: '' });
  return ok(res, { configured: true, preferredMethod: profile.preferredMethod,
    bank: { accountTitle: profile.bank?.accountTitle, bankName: profile.bank?.bankName, destination: maskAccount(profile.bank?.iban || profile.bank?.accountNumber) },
    mobileWallet: { provider: profile.mobileWallet?.provider, accountTitle: profile.mobileWallet?.accountTitle, destination: maskAccount(profile.mobileWallet?.number) },
    crypto: { asset: profile.crypto?.asset, network: profile.crypto?.network, destination: maskAccount(profile.crypto?.address) }
  });
});

const markPayslipPaid = asyncHandler(async (req, res) => {
  const { paymentMethod, reference, proofUrl, provider } = req.body;
  if (!paymentMethod || !PAYSLIP_METHOD_LABEL[paymentMethod]) {
    throw new AppError('A valid paymentMethod is required (bank_transfer, mobile_wallet, cash or other).', 422);
  }

  const payslip = await Payslip.findById(req.params.payslipId);
  if (!payslip) throw new AppError('Payslip not found.', 404);

  const institution = await Institution.findById(payslip.institution);
  assertOwnerOrStaff(institution, req.user._id);
  assertInstitutionVerified(institution);

  if (payslip.status === 'paid') throw new AppError('This payslip has already been paid.', 409);
  const payoutProfile = await PayoutProfile.findOne({ user: payslip.staff });
  if (paymentMethod === 'bank_transfer' && !(payoutProfile?.bank?.iban || payoutProfile?.bank?.accountNumber)) throw new AppError('Employee must save bank payout details before bank transfer.', 422);
  if (paymentMethod === 'mobile_wallet' && !payoutProfile?.mobileWallet?.number) throw new AppError('Employee must save mobile wallet details before mobile-wallet payment.', 422);
  if (paymentMethod === 'crypto' && !payoutProfile?.crypto?.address) throw new AppError('Employee must save a crypto address and network before crypto payment.', 422);
  if (paymentMethod === 'platform_wallet') {
    // Verified BEFORE anything is touched — the recipient must be a real account tied to this
    // exact payslip's employment record. If they somehow don't exist, this throws here and zero
    // balance has moved yet, so there is nothing to reverse.
    const recipientUser = await User.findById(payslip.staff).select('fullName email');
    if (!recipientUser) throw new AppError('The employee account for this payslip no longer exists — cannot pay.', 422);
    const reference = generateTransactionId();
    await mongoose.connection.transaction(async (session) => {
      const sender = await Wallet.findOneAndUpdate(
        { user: institution.owner, currency: payslip.currency, available: { $gte: payslip.netAmount } },
        { $inc: { available: -payslip.netAmount } }, { new: true, session }
      );
      if (!sender) throw new AppError(`Institution wallet has insufficient ${payslip.currency} balance.`, 422);
      await Wallet.findOneAndUpdate(
        { user: payslip.staff, currency: payslip.currency }, { $inc: { available: payslip.netAmount } },
        { upsert: true, new: true, session, setDefaultsOnInsert: true }
      );
      // Same `reference` on both legs — the institution and the employee each see the identical
      // receipt number in their own wallet history, so either side can find/prove this exact
      // movement independently.
      await WalletTransaction.create([
        { user: institution.owner, type: 'transfer_out', amount: payslip.netAmount, currency: payslip.currency, status: 'completed', counterparty: payslip.staff, reference, note: `Salary ${payslip.month}/${payslip.year} · ${institution.name} · to ${recipientUser.fullName} (${recipientUser.email})` },
        { user: payslip.staff, type: 'transfer_in', amount: payslip.netAmount, currency: payslip.currency, status: 'completed', counterparty: institution.owner, reference, note: `Salary ${payslip.month}/${payslip.year} · ${institution.name}` }
      ], { session, ordered: true });
      payslip.status = 'paid'; payslip.paidAt = new Date(); payslip.paymentMethod = paymentMethod; payslip.transactionId = reference;
      await payslip.save({ session });
    });
  } else {
    if (!String(reference || '').trim()) throw new AppError('Payment reference or cash receipt number is required.', 422);
    if (paymentMethod !== 'cash' && !String(proofUrl || '').trim()) throw new AppError('Payment proof is required for manual salary payments.', 422);
    payslip.status = 'processing'; payslip.paymentMethod = paymentMethod;
    payslip.paymentReference = String(reference).trim(); payslip.paymentProofUrl = String(proofUrl || '').trim();
    payslip.paymentProvider = String(provider || '').trim(); payslip.paymentReportedAt = new Date();
    await payslip.save();
  }
  await notify(payslip.staff, {
    title: payslip.status === 'processing' ? `Salary payment reported: ${payslip.currency} ${payslip.netAmount}` : `Salary paid: ${payslip.currency} ${payslip.netAmount} (receipt ${payslip.transactionId})`,
    body: payslip.status === 'processing' ? `${institution.name} reported payment for ${payslip.month}/${payslip.year}. Confirm it after the money reaches you.` : `${payslip.month}/${payslip.year} - ${institution.name}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, payslip, payslip.status === 'processing' ? 'Salary payment submitted for teacher verification.' : 'Payslip marked as paid.');
});

// ---- Reports ----
const getInstitutionReports = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const HelpDeskTicket = require('../models/HelpDeskTicket');
  const InstitutionEvent = require('../models/InstitutionEvent');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [studentsCount, teachersCount, classSectionsCount, campusesCount, feeAgg, attendanceRecords, pendingPayroll, todayAttendanceDoc, newAdmissions, openComplaints, upcomingEvents] = await Promise.all([
    StudentProfile.countDocuments({ primaryInstitution: institution._id }),
    TeacherProfile.countDocuments({ institutions: institution._id }),
    ClassSection.countDocuments({ institution: institution._id }),
    Campus.countDocuments({ institution: institution._id }),
    Fee.aggregate([
      { $match: { institution: institution._id } },
      { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Attendance.find({ institution: institution._id }).sort({ date: -1 }).limit(100),
    Payslip.countDocuments({ institution: institution._id, status: 'pending' }),
    Attendance.find({ institution: institution._id, date: { $gte: startOfDay } }),
    StudentProfile.countDocuments({ primaryInstitution: institution._id, admissionDate: { $gte: thirtyDaysAgo } }),
    HelpDeskTicket.countDocuments({ institution: institution._id, status: { $in: ['open', 'in_progress'] } }),
    InstitutionEvent.countDocuments({ institution: institution._id, status: { $in: ['upcoming', 'ongoing'] } })
  ]);

  let todayPresent = 0, todayTotal = 0;
  todayAttendanceDoc.forEach((r) => r.records.forEach((entry) => { todayTotal += 1; if (entry.status === 'present') todayPresent += 1; }));
  const todayAttendanceRate = todayTotal > 0 ? Math.round((todayPresent / todayTotal) * 100) : null;

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
    todayAttendanceRate,
    pendingPayroll,
    newAdmissions,
    openComplaints,
    upcomingEvents
  });
});

// POST /api/institutions/:id/ai-insights â€” AI Operations Assistant (spec 15D.19). Uses the
// institution's own BYOK AI text credential (same pattern as the AI Creative Teacher tools) to
// analyze REAL aggregated institution data â€” never fabricated numbers, the AI only summarizes
// what getInstitutionReports already computed. All decisions stay with the institution â€” this
// only produces a written summary/alerts, it never changes any data itself.
const getAiInsights = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const [studentsCount, teachersCount, feeAgg, pendingPayroll, openComplaints] = await Promise.all([
    StudentProfile.countDocuments({ primaryInstitution: institution._id }),
    TeacherProfile.countDocuments({ institutions: institution._id }),
    Fee.aggregate([
      { $match: { institution: institution._id } },
      { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Payslip.countDocuments({ institution: institution._id, status: 'pending' }),
    require('../models/HelpDeskTicket').countDocuments({ institution: institution._id, status: { $in: ['open', 'in_progress'] } })
  ]);
  const fees = { collected: 0, pending: 0, overdue: 0 };
  feeAgg.forEach((row) => { if (fees[row._id] !== undefined) fees[row._id] = row.total; });

  const dataSummary = `Institution: ${institution.name}
Students: ${studentsCount}
Teachers: ${teachersCount}
Fees collected: ${fees.collected}
Fees pending: ${fees.pending}
Fees overdue: ${fees.overdue}
Pending payroll (unpaid payslips): ${pendingPayroll}
Open help-desk tickets: ${openComplaints}`;

  const aiService = require('../services/ai.service');
  try {
    const result = await aiService.generate(
      req.user._id,
      'You are an institution operations assistant for a school/college. Given real, structured operational data, write a short (5-8 bullet points) analysis: highlight fee-collection risk, payroll status, support/complaint load, and 1-2 concrete recommended actions. Be specific to the numbers given, never invent numbers not provided. All decisions remain the institution\'s own â€” you are only summarizing, not deciding.',
      dataSummary
    );
    return ok(res, { insights: result, dataSummary });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// ---- Examination Management (institution-wide view) ----
const listInstitutionExams = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const courses = await Course.find({ institution: institution._id }).select('_id title subject teacher classSection');
  const courseIds = courses.map((c) => c._id);
  const courseMap = Object.fromEntries(courses.map((c) => [c._id.toString(), c.title]));

  const exams = await Exam.find({ course: { $in: courseIds } })
    .populate('teacher', 'fullName email')
    .populate('course', 'title subject')
    .populate('classSection', 'name academicYear')
    .sort({ scheduledDate: -1 });

  const ExamSubmission = require('../models/ExamSubmission');
  const examIds = exams.map((exam) => exam._id);
  const summaries = await ExamSubmission.aggregate([
    { $match: { exam: { $in: examIds } } },
    { $group: { _id: '$exam', attempted: { $sum: 1 }, graded: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } }, passed: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, { $cond: [{ $gte: ['$score', 0] }, 1, 0] }, 0] } } } }
  ]);
  const summaryMap = new Map(summaries.map((summary) => [summary._id.toString(), summary]));
  const withCourseTitle = exams.map((e) => {
    const summary = summaryMap.get(e._id.toString());
    return { ...e.toObject(), courseTitle: e.course?.title || courseMap[e.course?._id?.toString() || e.course?.toString()], attemptedCount: summary?.attempted || 0, gradedCount: summary?.graded || 0 };
  });
  return ok(res, withCourseTitle);
});

// GET /api/institutions/mine/staff-roles â€” every institution the current user is staff at,
// and their exact staff.role there. The frontend uses this to decide whether to show the
// full Institution workspace or the scoped-down Representative dashboard.
const myStaffRoles = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({ 'staff.user': req.user._id }).select('name logo staff');
  const roles = institutions.map((inst) => {
    const entry = inst.staff.find((s) => s.user.toString() === req.user._id.toString());
    return { institutionId: inst._id, institutionName: inst.name, institutionLogo: inst.logo, role: entry?.role || 'staff', department: entry?.department || '', permissions: entry?.permissions || [] };
  });
  return ok(res, roles);
});

// GET /api/institutions/mine/rep-dashboard â€” the Institute Representative home page.
// Scoped to the first institution where this user's staff.role is "representative".
const getRepDashboard = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({ 'staff.user': req.user._id });
  const withRole = institutions.map((inst) => ({ inst, entry: inst.staff.find((s) => s.user.toString() === req.user._id.toString()) }))
    .find((x) => x.entry?.role === 'representative');

  if (!withRole) throw new AppError('You are not registered as a Representative at any institution.', 403);
  const { inst, entry } = withRole;

  const [inquiries, applications, meetings, unreadMessages, campuses] = await Promise.all([
    Inquiry.find({ institution: inst._id }).populate('student', 'fullName').sort({ createdAt: -1 }),
    InstitutionApplication.find({ institution: inst._id }).populate('applicant', 'fullName').sort({ createdAt: -1 }),
    Meeting.find({ institution: inst._id, representative: req.user._id }).populate('student', 'fullName').sort({ scheduledDate: 1 }),
    Message.countDocuments({ to: req.user._id, read: false }),
    Campus.find({ institution: inst._id })
  ]);

  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const upcomingMeetings = meetings.filter((m) => m.status === 'scheduled' && m.scheduledDate >= now);
  const meetingReminders = upcomingMeetings.filter((m) => m.scheduledDate <= in48h);
  const completedConsultations = meetings.filter((m) => m.status === 'completed').length;
  const pendingStatuses = ['submitted', 'under_review', 'documents_required'];

  // "Meeting reminder" / "Admission deadline" notifications â€” this codebase has no
  // cron/scheduler, so both are checked lazily on real dashboard load, same pattern as the
  // job-seeker's application-deadline reminder. Deduped by title so refreshing doesn't spam.
  await Promise.all(meetingReminders.map(async (m) => {
    const title = `Meeting reminder: ${m.student?.fullName || 'a student'} â€” ${new Date(m.scheduledDate).toLocaleString()}`;
    const already = await Notification.findOne({ user: req.user._id, title });
    if (!already) await notify(req.user._id, { title, body: m.program || inst.name, sentBy: null }).catch(() => {});
  }));
  if (inst.admissionDeadline) {
    const deadline = new Date(inst.admissionDeadline);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (deadline > now && deadline <= in7Days) {
      const title = `Admission deadline approaching: ${inst.name}`;
      const already = await Notification.findOne({ user: req.user._id, title });
      if (!already) await notify(req.user._id, { title, body: `Deadline: ${deadline.toLocaleDateString()}`, sentBy: null }).catch(() => {});
    }
  }
  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(8);

  // "Admission progress" â€” a real, computed stage indicator (not a fabricated number),
  // derived from where the application actually sits in its own status pipeline.
  const PROGRESS_BY_STATUS = { draft: 0, submitted: 25, under_review: 50, documents_required: 60, accepted: 100, rejected: 100 };
  const applicationsWithProgress = applications.map((a) => ({ ...a.toObject(), admissionProgress: PROGRESS_BY_STATUS[a.status] ?? 0 }));

  const recentActivity = [
    ...inquiries.filter((i) => i.responses.length > 0).map((i) => ({ id: `inq-${i._id}`, title: `Responded to ${i.student?.fullName || 'a student'}'s inquiry`, time: i.updatedAt })),
    ...inquiries.filter((i) => i.status === 'follow_up').map((i) => ({ id: `inqfu-${i._id}`, title: `Flagged ${i.student?.fullName || 'a student'} for follow-up`, time: i.updatedAt })),
    ...applications.filter((a) => a.reviewedBy).map((a) => ({ id: `app-${a._id}`, title: `Reviewed ${a.applicant?.fullName || 'an applicant'}'s application (${a.status})`, time: a.updatedAt })),
    ...applications.filter((a) => !a.reviewedBy && ['under_review', 'documents_required'].includes(a.status)).map((a) => ({ id: `appstat-${a._id}`, title: `Updated ${a.applicant?.fullName || 'an applicant'}'s status to ${a.status.replace('_', ' ')}`, time: a.updatedAt })),
    ...applications.filter((a) => a.documents?.length > 0).flatMap((a) => a.documents.map((d, di) => ({ id: `doc-${a._id}-${di}`, title: `${a.applicant?.fullName || 'An applicant'} shared a document: ${d.name}`, time: a.updatedAt }))),
    ...meetings.filter((m) => m.status === 'completed').map((m) => ({ id: `meet-${m._id}`, title: `Completed consultation with ${m.student?.fullName || 'a student'}`, time: m.updatedAt }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

  return ok(res, {
    profile: {
      institutionId: inst._id, institutionName: inst.name, institutionLogo: inst.logo,
      designation: entry.designation || entry.role, department: entry.department || '', verificationStatus: inst.verificationStatus,
      contactEmail: inst.contactEmail, contactPhone: inst.contactPhone
    },
    counts: {
      newInquiries: inquiries.filter((i) => i.status === 'new').length,
      assignedApplications: applications.filter((a) => a.assignedRepresentative?.toString() === req.user._id.toString()).length,
      pendingApplications: applications.filter((a) => pendingStatuses.includes(a.status)).length,
      upcomingMeetings: upcomingMeetings.length,
      unreadMessages,
      completedConsultations
    },
    inquiries: inquiries.slice(0, 10),
    applications: applicationsWithProgress.slice(0, 10),
    upcomingMeetings: upcomingMeetings.slice(0, 5),
    followUps: {
      followUpInquiries: inquiries.filter((i) => i.status === 'follow_up'),
      documentsRequired: applications.filter((a) => a.status === 'documents_required'),
      unansweredInquiries: inquiries.filter((i) => i.status === 'new' && i.responses.length === 0),
      pendingApplicationActions: applications.filter((a) => ['submitted', 'under_review'].includes(a.status)),
      meetingReminders,
      admissionDeadline: inst.admissionDeadline
    },
    institutionInfo: {
      admissionRequirements: inst.admissionRequirements,
      admissionDeadline: inst.admissionDeadline,
      campuses
    },
    recentActivity,
    notifications
  });
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
  updateStaffAiPermissions,
  listInstitutionParents,
  verifyParentLink,
  getInstitutionFeedback,
  getInstitutionFeedbackSummary,
  listStaffAttendance,
  listCampusBuildings,
  createCampusBuilding,
  updateCampusBuilding,
  deleteCampusBuilding,
  createCampus,
  listCampuses,
  createClassSection,
  listClassSections,
  updateClassSection,
  createFee,
  listFees,
  markFeePaid,
  releaseFeeEscrow,
  remindFee,
  requestFeeRefund,
  decideFeeRefund,
  createTimetableEntry,
  listTimetable,
  updateTimetableEntry,
  deleteTimetableEntry,
  listInstitutionCourses,
  assignCourseAcademics,
  listInstitutionTeachers,
  listInstitutionStudents,
  updateStudentStatus,
  listInstitutionAttendance,
  listMembershipRequests,
  reviewMembershipRequest,
  createPayslip,
  listInstitutionPayroll,
  markPayslipPaid,
  generateMonthlyPayroll,
  runPayrollAutomationForInstitution,
  getPayrollTaxReport,
  getInstitutionReports,
  getAiInsights,
  listInstitutionExams,
  myStaffRoles,
  getRepDashboard
  ,getMyPayoutProfile, saveMyPayoutProfile, getStaffPayoutProfile
  ,createProgram, listPrograms
};
