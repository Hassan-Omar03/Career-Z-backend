// Institution Operations — spec Part 15D: Library (15D.10), Hostel (15D.11), Transport (15D.12),
// Inventory (15D.13), Medical & Health (15D.14), Events & Activities (15D.17) and the
// institution-scoped Help Desk (15D.16). Grouped in one controller since each module is a small,
// independent CRUD surface reusing the same owner/staff permission check as institution.controller.js.
const Institution = require('../models/Institution');
const StudentProfile = require('../models/StudentProfile');
const LibraryBook = require('../models/LibraryBook');
const LibraryLoan = require('../models/LibraryLoan');
const HostelRoom = require('../models/HostelRoom');
const HostelRequest = require('../models/HostelRequest');
const Vehicle = require('../models/Vehicle');
const TransportJourney = require('../models/TransportJourney');
const InventoryItem = require('../models/InventoryItem');
const HealthIncident = require('../models/HealthIncident');
const InstitutionApplication = require('../models/InstitutionApplication');
const TeacherEmployment = require('../models/TeacherEmployment');
const InstitutionEvent = require('../models/InstitutionEvent');
const HelpDeskTicket = require('../models/HelpDeskTicket');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const ParentChildLink = require('../models/ParentChildLink');
const Fee = require('../models/Fee');
const FeeSchedule = require('../models/FeeSchedule');
const { generateCurrentCycle } = require('../utils/feeSchedule');
const FuelLog = require('../models/FuelLog');
const VehicleMaintenanceLog = require('../models/VehicleMaintenanceLog');
const HostelAttendance = require('../models/HostelAttendance');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyParentsOfStudent } = require('../services/notification.service');

// Both hostel allocation and transport assignment must only ever target a real, active student
// of THIS institution — never a raw, unverified User ID (spec: "membership not verified at
// allocation time" was a real gap; this closes it for both modules).
async function assertActiveMember(studentId, institutionId) {
  const membership = await StudentInstitutionMembership.findOne({ student: studentId, institution: institutionId, status: 'active' });
  if (!membership) throw new AppError('This student is not an active member of your institution.', 422);
}

async function assertLibraryMember(studentId, institutionId) {
  const membership = await StudentInstitutionMembership.findOne({ student: studentId, institution: institutionId, status: { $in: ['active', 'graduated'] } });
  if (!membership) throw new AppError('This student is not an active or graduated member of your institution.', 422);
}

async function assertTransportApplicant(studentId, institutionId) {
  const application = await InstitutionApplication.findOne({
    applicant: studentId,
    institution: institutionId,
    status: 'accepted',
    'requestedServices.transport': true
  });
  if (!application) throw new AppError('Only an accepted student who selected transport during admission can be assigned.', 422);
  return application;
}

// A user may raise a Help Desk ticket at an institution only if they actually have a real
// relationship to it — student, teacher, staff/owner, or a parent of one of its students. Before
// this, createTicket had no check at all: any logged-in user could file a ticket at any
// institution id (spec gap flagged during Complaint & Help Desk review).
async function assertHasRelationshipToInstitution(userId, institutionId) {
  const institution = await Institution.findById(institutionId).select('owner staff');
  if (!institution) throw new AppError('Institution not found.', 404);
  if (institution.owner.toString() === userId.toString()) return;
  if (institution.staff.some((s) => s.user.toString() === userId.toString())) return;
  if (await StudentInstitutionMembership.exists({ student: userId, institution: institutionId, status: 'active' })) return;
  if (await TeacherEmployment.exists({ teacher: userId, institution: institutionId, status: 'active' })) return;
  const childIds = await StudentInstitutionMembership.find({ institution: institutionId, status: 'active' }).distinct('student');
  if (childIds.length && await ParentChildLink.exists({ parent: userId, student: { $in: childIds }, status: 'approved' })) return;
  throw new AppError('You have no relationship with this institution.', 403);
}

async function assertActiveInstitutionDriver(driverUserId, institutionId) {
  if (!driverUserId) return null;
  const employment = await TeacherEmployment.findOne({
    teacher: driverUserId,
    institution: institutionId,
    role: 'driver',
    status: 'active'
  });
  const institution = await Institution.findById(institutionId).select('staff');
  const staff = institution?.staff?.find((entry) => entry.user?.toString() === driverUserId.toString() && entry.role === 'driver');
  if (!employment || !staff) throw new AppError('Driver must be an active driver employed by this institution.', 422);
  return employment;
}

// Creates (idempotently, once per calendar month) the current month's hostel/transport charge as
// a plain Fee — reuses the existing feeType enum, so it shows up in the student's normal fee list,
// defaulter checks and reports exactly like any other fee. Not tied to a FeeSchedule snapshot
// (hostel/transport charges are billed per-occupancy, not per-academic-program).
async function ensureCurrentMonthOpsFee(institutionId, studentId, feeType, title, monthlyFee, currency, actingUserId) {
  // Transport prices require an institution review every month; only hostel remains automatic.
  if (feeType === 'transport') return null;
  if (!monthlyFee || monthlyFee <= 0) return;
  const now = new Date();
  const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // A schedule-linked admission voucher suppresses only this same month's operational bill.
  // A voucher from an older month must never stop recurring hostel/mess charges forever.
  const existing = await Fee.findOne({ institution: institutionId, student: studentId, feeType, billingPeriod, status: { $ne: 'cancelled' } });
  if (existing) return;
  const dueDate = new Date(now.getFullYear(), now.getMonth(), 10);
  await Fee.create({
    institution: institutionId, student: studentId, feeType, title, billingPeriod,
    amount: monthlyFee, currency: currency || 'PKR', dueDate, status: 'pending',
    outstandingAmount: monthlyFee, recordedBy: actingUserId
  });
}

async function loadInstitutionAndAssert(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString()
    && s.permissions.some((permission) => ['institution:ops:manage', 'ops:manage'].includes(permission)));
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
  return institution;
}

function isOwnerOrOpsStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString()
    && s.permissions.some((permission) => ['institution:ops:manage', 'ops:manage'].includes(permission)));
  return isOwner || isStaff;
}

// A room's designated warden may manage that ONE room's requests/attendance without needing
// full institution ops:manage staff permission (spec: "Warden Dashboard" — a warden is scoped to
// their own room(s), not the whole institution).
async function assertOwnerOpsOrWarden(room, userId) {
  const institution = await Institution.findById(room.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (isOwnerOrOpsStaff(institution, userId)) return institution;
  if (room.warden && room.warden.toString() === userId.toString()) return institution;
  throw new AppError('You do not manage this hostel room.', 403);
}

function assertDesignatedWarden(room, userId) {
  if (room.warden && room.warden.toString() === userId.toString()) return;
  throw new AppError('Only the designated warden can perform this daily hostel operation.', 403);
}

// ======================= Library (15D.10) =======================

const listBooks = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const books = await LibraryBook.find({ institution: req.params.id }).sort({ title: 1 });
  return ok(res, books);
});

const findBookByQr = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const code = String(req.params.code || '').trim();
  const book = await LibraryBook.findOne({ institution: req.params.id, qrCode: code });
  if (!book) throw new AppError('No library resource matches this QR code.', 404);
  return ok(res, book);
});

const listLibraryBorrowers = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const memberIds = await StudentInstitutionMembership.find({ institution: req.params.id, status: { $in: ['active', 'graduated'] } }).distinct('student');
  const students = await StudentProfile.find({ user: { $in: memberIds } }).populate('user', 'fullName email').sort({ createdAt: -1 });
  return ok(res, students);
});

const createBook = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { title, author, isbn, category, copies, fileUrl, coverImage } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  const digitalCategories = ['ebook', 'journal', 'research_paper', 'video', 'audio_lecture', 'slides', 'notes'];
  if (digitalCategories.includes(category) && !fileUrl) throw new AppError('A digital file URL is required for this resource type.', 422);
  const book = await LibraryBook.create({
    institution: req.params.id, title, author: author || '', isbn: isbn || '',
    category: category || 'book', copies: copies ?? 1, availableCopies: copies ?? 1,
    fileUrl: fileUrl || '', coverImage: coverImage || '', addedBy: req.user._id
  });
  return created(res, book, 'Book added.');
});

const updateBook = asyncHandler(async (req, res) => {
  const book = await LibraryBook.findById(req.params.bookId);
  if (!book) throw new AppError('Book not found.', 404);
  await loadInstitutionAndAssert(book.institution, req.user._id);
  const allowed = ['title', 'author', 'isbn', 'category', 'copies', 'availableCopies', 'fileUrl', 'coverImage'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) book[f] = req.body[f]; });
  await book.save();
  return ok(res, book, 'Book updated.');
});

const deleteBook = asyncHandler(async (req, res) => {
  const book = await LibraryBook.findById(req.params.bookId);
  if (!book) throw new AppError('Book not found.', 404);
  await loadInstitutionAndAssert(book.institution, req.user._id);
  await LibraryBook.deleteOne({ _id: book._id });
  return ok(res, null, 'Book removed.');
});

const borrowBook = asyncHandler(async (req, res) => {
  const book = await LibraryBook.findById(req.params.bookId);
  if (!book) throw new AppError('Book not found.', 404);
  await loadInstitutionAndAssert(book.institution, req.user._id);
  if (book.availableCopies <= 0) throw new AppError('No copies available.', 400);

  const { borrower, dueDate, finePerDay } = req.body;
  if (!borrower || !dueDate) throw new AppError('borrower and dueDate are required.', 422);
  await assertLibraryMember(borrower, book.institution);
  const existingLoan = await LibraryLoan.findOne({ book: book._id, borrower, status: { $in: ['borrowed', 'overdue'] } });
  if (existingLoan) throw new AppError('This student already has this resource on loan.', 409);

  const loan = await LibraryLoan.create({
    institution: book.institution, book: book._id, borrower, dueDate,
    finePerDay: finePerDay || 0, issuedBy: req.user._id
  });
  book.availableCopies -= 1;
  await book.save();

  await notify(borrower, { title: `Book borrowed: ${book.title}`, body: `Due ${new Date(dueDate).toLocaleDateString()}`, sentBy: req.user._id }).catch(() => {});
  return created(res, loan, 'Book issued.');
});

const returnBook = asyncHandler(async (req, res) => {
  const loan = await LibraryLoan.findById(req.params.loanId).populate('book');
  if (!loan) throw new AppError('Loan not found.', 404);
  await loadInstitutionAndAssert(loan.institution, req.user._id);
  if (loan.status === 'returned') throw new AppError('Already returned.', 400);

  loan.returnedAt = new Date();
  loan.status = 'returned';
  if (!loan.fineWaived && loan.finePerDay > 0 && loan.returnedAt > loan.dueDate) {
    const daysLate = Math.ceil((loan.returnedAt - loan.dueDate) / (1000 * 60 * 60 * 24));
    loan.fineAmount = daysLate * loan.finePerDay;
  }
  await loan.save();

  await LibraryBook.findByIdAndUpdate(loan.book._id, { $inc: { availableCopies: 1 } });
  return ok(res, loan, 'Book returned.');
});

const listLoans = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const loans = await LibraryLoan.find({ institution: req.params.id }).populate('book', 'title').populate('borrower', 'fullName').sort({ createdAt: -1 });
  return ok(res, loans);
});

const waiveLibraryFine = asyncHandler(async (req, res) => {
  const loan = await LibraryLoan.findById(req.params.loanId).populate('book', 'title');
  if (!loan) throw new AppError('Loan not found.', 404);
  await loadInstitutionAndAssert(loan.institution, req.user._id);
  loan.fineWaived = true;
  loan.fineAmount = 0;
  await loan.save();
  await notify(loan.borrower, { title: `Library fine waived: ${loan.book?.title || 'Library resource'}`, body: req.body.reason || 'Your institution waived this fine.', sentBy: req.user._id }).catch(() => {});
  return ok(res, loan, 'Library fine waived.');
});

const getMyLibrary = asyncHandler(async (req, res) => {
  // Viewing the library (and, crucially, your own loan/fine history) should not hard-require
  // 'active' status — a graduated or transferred student may still owe a fine or need to return
  // a book, and should still be able to see that. Only a withdrawn/rejected membership (never a
  // real relationship to begin with, or formally cut off) is excluded.
  const memberships = await StudentInstitutionMembership.find({ student: req.user._id, status: { $nin: ['withdrawn', 'rejected', 'pending'] } }).select('institution');
  const institutionIds = [...new Set(memberships.map((entry) => String(entry.institution)))];
  if (!institutionIds.length) throw new AppError('You are not linked to any institution.', 404);
  const [books, loans] = await Promise.all([
    LibraryBook.find({ institution: { $in: institutionIds } }).populate('institution', 'name').sort({ title: 1 }),
    LibraryLoan.find({ institution: { $in: institutionIds }, borrower: req.user._id }).populate('institution', 'name').populate('book', 'title author category fileUrl').sort({ borrowedAt: -1 })
  ]);
  return ok(res, { institutionIds, books, loans });
});

const getMyInstitutionEvents = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id }).select('primaryInstitution');
  if (!profile?.primaryInstitution) throw new AppError('You are not linked to an institution.', 404);
  await assertActiveMember(req.user._id, profile.primaryInstitution);
  const events = await InstitutionEvent.find({ institution: profile.primaryInstitution, status: { $ne: 'cancelled' }, $or: [{ audience: { $size: 0 } }, { audience: 'students' }] }).sort({ startDate: 1 });
  return ok(res, { institutionId: profile.primaryInstitution, userId: req.user._id, events });
});

// ======================= Hostel (15D.11) =======================

const listHostelRooms = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const rooms = await HostelRoom.find({ institution: req.params.id }).populate('occupants', 'fullName').populate('warden', 'fullName').sort({ roomNumber: 1 });
  return ok(res, rooms);
});

const listHostelEligibleStudents = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const applications = await InstitutionApplication.find({ institution: req.params.id, status: 'accepted', 'requestedServices.hostel': true })
    .populate('applicant', 'fullName email')
    .sort({ createdAt: -1 });
  const profiles = await StudentProfile.find({ user: { $in: applications.map((item) => item.applicant?._id).filter(Boolean) } })
    .populate('classSection', 'name academicYear');
  const profileByUser = new Map(profiles.map((profile) => [String(profile.user), profile]));
  const allocatedRooms = await HostelRoom.find({ institution: req.params.id, 'occupants.0': { $exists: true } }).select('roomNumber occupants');
  const allocated = new Map();
  allocatedRooms.forEach((room) => room.occupants.forEach((userId) => allocated.set(String(userId), room.roomNumber)));
  return ok(res, applications.map((application) => {
    const profile = profileByUser.get(String(application.applicant?._id));
    return {
      user: application.applicant,
      program: application.program,
      department: application.feePlanSnapshot?.department || '',
      rollNumber: profile?.rollNumber || '',
      classSection: profile?.classSection || null,
      hostelFee: application.feePlanSnapshot?.additionalFees?.hostel?.amount || 0,
      currency: application.feePlanSnapshot?.currency || 'PKR',
      allocatedRoom: allocated.get(String(application.applicant?._id)) || null
    };
  }));
});

const createHostelRoom = asyncHandler(async (req, res) => {
  const institution = await loadInstitutionAndAssert(req.params.id, req.user._id);
  if (institution.type === 'online_institute') throw new AppError('Hostel management is available only to physical-campus institutions.', 403);
  const { building, roomNumber, floor, capacity, monthlyFee, warden } = req.body;
  if (!roomNumber || !capacity) throw new AppError('roomNumber and capacity are required.', 422);
  if (warden) {
    const employment = await TeacherEmployment.exists({ institution: institution._id, teacher: warden, role: 'warden', status: 'active' });
    if (!employment) throw new AppError('Select an active hostel warden formally hired by this institution.', 422);
  }
  const room = await HostelRoom.create({ institution: req.params.id, building: building || '', roomNumber, floor: floor || '', capacity, monthlyFee: monthlyFee || 0, warden: warden || null });
  return created(res, room, 'Room added.');
});

const updateHostelRoom = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  await loadInstitutionAndAssert(room.institution, req.user._id);
  const allowed = ['building', 'roomNumber', 'floor', 'capacity', 'monthlyFee', 'warden', 'status'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) room[f] = req.body[f]; });
  await room.save();
  return ok(res, room, 'Room updated.');
});

const allocateHostelRoom = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  await loadInstitutionAndAssert(room.institution, req.user._id);
  const { student } = req.body;
  if (!student) throw new AppError('student is required.', 422);
  await assertActiveMember(student, room.institution);
  const optedIn = await InstitutionApplication.exists({ institution: room.institution, applicant: student, status: 'accepted', 'requestedServices.hostel': true });
  if (!optedIn) throw new AppError('This student did not request hostel during admission.', 422);
  if (room.occupants.length >= room.capacity) throw new AppError('Room is full.', 400);
  if (room.occupants.some((o) => o.toString() === student)) throw new AppError('Student already allocated to this room.', 409);
  // A student may only ever hold one room at a given institution — use Transfer to move them,
  // not a second allocation (spec gap: "student can be allocated to multiple rooms").
  const existingRoom = await HostelRoom.findOne({ institution: room.institution, occupants: student });
  if (existingRoom) throw new AppError(`This student already has room ${existingRoom.roomNumber} — use Transfer instead.`, 409);

  room.occupants.push(student);
  if (room.occupants.length >= room.capacity) room.status = 'full';
  await room.save();
  await ensureCurrentMonthOpsFee(room.institution, student, 'hostel', `Hostel Fee — ${room.roomNumber}`, room.monthlyFee, room.currency, req.user._id);

  await notify(student, { title: `Hostel room allocated: ${room.roomNumber}`, body: room.building, sentBy: req.user._id }).catch(() => {});
  return ok(res, room, 'Student allocated.');
});

// Moves a student from their current room to a different one in one step (check-out of the old
// room + allocation to the new one), so a room change never briefly leaves them "unassigned" or,
// worse, double-booked into two rooms at once.
const transferHostelStudent = asyncHandler(async (req, res) => {
  const newRoom = await HostelRoom.findById(req.params.roomId);
  if (!newRoom) throw new AppError('Room not found.', 404);
  await loadInstitutionAndAssert(newRoom.institution, req.user._id);
  const { student } = req.body;
  if (!student) throw new AppError('student is required.', 422);
  await assertActiveMember(student, newRoom.institution);
  if (newRoom.occupants.length >= newRoom.capacity) throw new AppError('Target room is full.', 400);
  if (newRoom.occupants.some((o) => o.toString() === student)) throw new AppError('Student is already in the target room.', 409);

  const oldRoom = await HostelRoom.findOne({ institution: newRoom.institution, occupants: student });
  if (oldRoom) {
    oldRoom.occupants = oldRoom.occupants.filter((o) => o.toString() !== student);
    oldRoom.status = 'available';
    await oldRoom.save();
  }

  newRoom.occupants.push(student);
  if (newRoom.occupants.length >= newRoom.capacity) newRoom.status = 'full';
  await newRoom.save();
  await ensureCurrentMonthOpsFee(newRoom.institution, student, 'hostel', `Hostel Fee — ${newRoom.roomNumber}`, newRoom.monthlyFee, newRoom.currency, req.user._id);

  await notify(student, { title: `Hostel room transferred: ${newRoom.roomNumber}`, body: oldRoom ? `Moved from ${oldRoom.roomNumber}` : '', sentBy: req.user._id }).catch(() => {});
  return ok(res, newRoom, 'Student transferred.');
});

const removeHostelOccupant = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  await loadInstitutionAndAssert(room.institution, req.user._id);
  room.occupants = room.occupants.filter((o) => o.toString() !== req.params.userId);
  room.status = 'available';
  await room.save();
  await notify(req.params.userId, { title: `Checked out of hostel room ${room.roomNumber}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, room, 'Occupant checked out.');
});

// GET /api/institution-ops/hostel/me — the logged-in student's own room(s) across every
// institution, plus their own request history. Without this, a student has no way to discover
// their own room id in order to submit a visitor/leave request at all.
const getMyHostelStatus = asyncHandler(async (req, res) => {
  const rooms = await HostelRoom.find({ occupants: req.user._id }).populate('institution', 'name').populate('warden', 'fullName');
  const requests = await HostelRequest.find({ student: req.user._id }).populate('room', 'roomNumber').populate('institution', 'name').sort({ createdAt: -1 });
  return ok(res, { rooms, requests });
});

const createHostelRequest = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.body.room);
  if (!room) throw new AppError('Room not found.', 404);
  const { type, visitorName, visitorRelation, visitDate, fromDate, toDate, reason } = req.body;
  if (!['visitor', 'leave'].includes(type)) throw new AppError('type must be visitor or leave.', 422);

  const request = await HostelRequest.create({
    institution: room.institution, room: room._id, student: req.user._id, type,
    visitorName: visitorName || '', visitorRelation: visitorRelation || '', visitDate: visitDate || null,
    fromDate: fromDate || null, toDate: toDate || null, reason: reason || ''
  });

  const institution = await Institution.findById(room.institution);
  const recipients = [institution.owner, ...(room.warden ? [room.warden] : [])];
  await Promise.all(recipients.map((id) => notify(id, { title: `New hostel ${type} request`, body: reason || visitorName || '', sentBy: req.user._id }).catch(() => {})));

  return created(res, request, 'Request submitted.');
});

const listHostelRequests = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const requests = await HostelRequest.find({ institution: req.params.id })
    .populate('student', 'fullName')
    .populate('room', 'roomNumber')
    .populate('reviewedBy', 'fullName')
    .sort({ createdAt: -1 });
  return ok(res, requests);
});

const decideHostelRequest = asyncHandler(async (req, res) => {
  const request = await HostelRequest.findById(req.params.requestId);
  if (!request) throw new AppError('Request not found.', 404);
  const room = await HostelRoom.findById(request.room);
  if (!room) throw new AppError('The hostel room for this request no longer exists.', 404);
  assertDesignatedWarden(room, req.user._id);
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);
  request.status = decision;
  request.reviewedBy = req.user._id;
  await request.save();
  await notify(request.student, { title: `Hostel ${request.type} request ${decision}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, request, `Request ${decision}.`);
});

// GET /api/institution-ops/hostel/warden-dashboard — every room where the logged-in user is the
// designated warden, plus pending requests and today's attendance status for those rooms only
// (spec: "Warden select karne ka UI aur Warden Dashboard nahi" — this is that dashboard).
const getWardenDashboard = asyncHandler(async (req, res) => {
  const rooms = await HostelRoom.find({ warden: req.user._id }).populate('occupants', 'fullName').populate('institution', 'name');
  const roomIds = rooms.map((r) => r._id);
  const pendingRequests = await HostelRequest.find({ room: { $in: roomIds }, status: 'pending' }).populate('student', 'fullName').populate('room', 'roomNumber').sort({ createdAt: -1 });
  const today = new Date().toISOString().slice(0, 10);
  const todaysAttendance = await HostelAttendance.find({ room: { $in: roomIds }, date: today });
  return ok(res, { rooms, pendingRequests, todaysAttendance });
});

// POST /api/institution-ops/hostel-rooms/:roomId/attendance — bulk-mark every occupant's status
// for one date in a single call (spec: "Hostel attendance missing").
const markHostelAttendance = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  assertDesignatedWarden(room, req.user._id);
  const { date, entries } = req.body; // entries: [{ student, status }]
  if (!date || !Array.isArray(entries) || entries.length === 0) throw new AppError('date and entries[] are required.', 422);

  const results = await Promise.all(entries.map(({ student, status }) =>
    HostelAttendance.findOneAndUpdate(
      { room: room._id, student, date },
      { institution: room.institution, room: room._id, student, date, status, markedBy: req.user._id },
      { upsert: true, new: true }
    )
  ));
  return ok(res, results, 'Attendance recorded.');
});

// GET /api/institution-ops/hostel-rooms/:roomId/attendance?date=YYYY-MM-DD
const listHostelAttendance = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  await assertOwnerOpsOrWarden(room, req.user._id);
  const filter = { room: room._id };
  if (req.query.date) filter.date = req.query.date;
  const records = await HostelAttendance.find(filter)
    .populate('student', 'fullName')
    .populate('markedBy', 'fullName')
    .sort({ date: -1, updatedAt: -1 });
  return ok(res, records);
});

// ======================= Transport (15D.12) =======================

const listVehicles = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const vehicles = await Vehicle.find({ institution: req.params.id }).populate('assignedStudents', 'fullName').sort({ vehicleNumber: 1 });
  const rows = await Promise.all(vehicles.map(async (vehicle) => {
    const activeJourney = await TransportJourney.findOne({ vehicle: vehicle._id, status: 'in_progress' }).sort({ startedAt: -1 });
    return { ...vehicle.toObject(), activeJourney };
  }));
  return ok(res, rows);
});

const createVehicle = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { vehicleNumber, type, capacity, driverName, driverPhone, driverLicenseNo, driverUser, routeName, stopPoints, monthlyFee, insuranceExpiry, fitnessExpiry } = req.body;
  if (!vehicleNumber) throw new AppError('vehicleNumber is required.', 422);
  await assertActiveInstitutionDriver(driverUser, req.params.id);
  const vehicle = await Vehicle.create({
    institution: req.params.id, vehicleNumber, type: type || 'bus', capacity: capacity || 0,
    driverName: driverName || '', driverPhone: driverPhone || '', driverLicenseNo: driverLicenseNo || '', driverUser: driverUser || null,
    routeName: routeName || '', stopPoints: stopPoints || [], monthlyFee: monthlyFee || 0,
    insuranceExpiry: insuranceExpiry || null, fitnessExpiry: fitnessExpiry || null, addedBy: req.user._id
  });
  return created(res, vehicle, 'Vehicle added.');
});

const updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  if (req.body.driverUser !== undefined && req.body.driverUser) await assertActiveInstitutionDriver(req.body.driverUser, vehicle.institution);
  if (req.body.monthlyFee !== undefined && Number(req.body.monthlyFee) > Number(vehicle.monthlyFee || 0)) {
    const reason = String(req.body.feeChangeReason || '').trim();
    if (!reason) throw new AppError('A reason is required when increasing the monthly transport fee.', 422);
    vehicle.feeChangeHistory.push({ previousAmount: vehicle.monthlyFee || 0, newAmount: Number(req.body.monthlyFee), reason, changedBy: req.user._id });
    await Promise.all((vehicle.assignedStudents || []).map((studentId) => notify(studentId, { title: `Transport fee updated: ${vehicle.vehicleNumber}`, body: `${vehicle.currency} ${vehicle.monthlyFee || 0} to ${vehicle.currency} ${Number(req.body.monthlyFee)}. Reason: ${reason}`, sentBy: req.user._id }).catch(() => {})));
  }
  const allowed = [
    'vehicleNumber', 'type', 'capacity', 'driverName', 'driverPhone', 'driverLicenseNo', 'driverUser',
    'routeName', 'stopPoints', 'monthlyFee', 'status', 'insuranceExpiry', 'fitnessExpiry', 'expectedDurationMinutes'
  ];
  allowed.forEach((f) => { if (req.body[f] !== undefined) vehicle[f] = req.body[f]; });
  await vehicle.save();
  return ok(res, vehicle, 'Vehicle updated.');
});

const deleteVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  await Vehicle.deleteOne({ _id: vehicle._id });
  return ok(res, null, 'Vehicle removed.');
});

const assignStudentToVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  const { student } = req.body;
  if (!student) throw new AppError('student is required.', 422);
  await assertActiveMember(student, vehicle.institution);
  await assertTransportApplicant(student, vehicle.institution);
  if (vehicle.assignedStudents.some((s) => s.toString() === student)) throw new AppError('Already assigned.', 409);
  // Capacity was previously never enforced at all — a vehicle could be overbooked indefinitely.
  if (vehicle.capacity > 0 && vehicle.assignedStudents.length >= vehicle.capacity) throw new AppError('Vehicle is at full capacity.', 400);
  // A student may only ride one vehicle at a given institution at a time (spec gap: "student can
  // be assigned to multiple vehicles").
  const existingVehicle = await Vehicle.findOne({ institution: vehicle.institution, assignedStudents: student });
  if (existingVehicle) throw new AppError(`This student is already assigned to vehicle ${existingVehicle.vehicleNumber} — remove them from it first.`, 409);

  vehicle.assignedStudents.push(student);
  await vehicle.save();
  await ensureCurrentMonthOpsFee(vehicle.institution, student, 'transport', `Transport Fee — ${vehicle.routeName || vehicle.vehicleNumber}`, vehicle.monthlyFee, vehicle.currency, req.user._id);

  await notify(student, { title: `Transport assigned: ${vehicle.vehicleNumber}`, body: vehicle.routeName, sentBy: req.user._id }).catch(() => {});
  return ok(res, vehicle, 'Student assigned.');
});

const removeStudentFromVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  vehicle.assignedStudents = vehicle.assignedStudents.filter((s) => s.toString() !== req.params.userId);
  await vehicle.save();
  await notify(req.params.userId, { title: `Removed from transport: ${vehicle.vehicleNumber}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, vehicle, 'Student removed.');
});

// Institution-reviewed monthly transport billing. Nothing is generated automatically because
// the institution may need to adjust the amount after fuel/operating cost changes.
const generateMonthlyTransportFees = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  const now = new Date();
  const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const reason = String(req.body.reason || '').trim() || 'Regular monthly transport service';
  let generated = 0; let skipped = 0;
  for (const studentId of vehicle.assignedStudents || []) {
    await assertTransportApplicant(studentId, vehicle.institution);
    const schedule = await FeeSchedule.findOne({ institution: vehicle.institution, student: studentId, status: 'active' });
    if (schedule?.billingFrequency === 'monthly') {
      await generateCurrentCycle(schedule, req.user._id).catch(() => {});
      const tuitionFee = await Fee.findOne({ schedule: schedule._id, student: studentId, feeType: 'tuition', billingPeriod, status: { $in: ['scheduled', 'pending', 'overdue', 'partially_paid'] } });
      if (!tuitionFee || (tuitionFee.components || []).some((component) => component.type === 'transport' && component.billingPeriod === billingPeriod)) { skipped += 1; continue; }
      const transportAmount = Number(vehicle.monthlyFee || 0);
      tuitionFee.components.push({ type: 'transport', label: `Transport — ${vehicle.routeName || vehicle.vehicleNumber}`, amount: transportAmount, billingPeriod, reason });
      tuitionFee.amount = Number(tuitionFee.amount || 0) + transportAmount;
      tuitionFee.originalAmount = Number(tuitionFee.originalAmount ?? tuitionFee.amount - transportAmount) + transportAmount;
      tuitionFee.outstandingAmount = Number(tuitionFee.outstandingAmount ?? tuitionFee.amount - transportAmount) + transportAmount;
      await tuitionFee.save();
      generated += 1;
      await notify(studentId, { title: `Transport added to monthly fee — ${billingPeriod}`, body: `${vehicle.currency} ${transportAmount}. ${reason}`, sentBy: req.user._id }).catch(() => {});
      continue;
    }
    const existing = await Fee.findOne({ institution: vehicle.institution, student: studentId, feeType: 'transport', billingPeriod, title: { $regex: vehicle.vehicleNumber } });
    if (existing) { skipped += 1; continue; }
    await Fee.create({
      student: studentId, institution: vehicle.institution,
      title: `Monthly Transport Fee — ${vehicle.vehicleNumber}`, feeType: 'transport',
      amount: vehicle.monthlyFee, originalAmount: vehicle.monthlyFee, outstandingAmount: vehicle.monthlyFee,
      currency: vehicle.currency, billingPeriod, academicYear: String(now.getFullYear()),
      dueDate: new Date(now.getFullYear(), now.getMonth(), 10), status: 'pending',
      components: [{ type: 'transport', label: vehicle.routeName || vehicle.vehicleNumber, amount: vehicle.monthlyFee, billingPeriod, reason }],
      recordedBy: req.user._id
    });
    generated += 1;
    await notify(studentId, { title: `Transport fee generated — ${billingPeriod}`, body: `${vehicle.currency} ${vehicle.monthlyFee}. ${reason}`, sentBy: req.user._id }).catch(() => {});
  }
  return ok(res, { billingPeriod, generated, skipped }, 'Monthly transport fees generated.');
});

// Owner/ops-staff, OR the vehicle's own designated driverUser (spec: "dedicated Driver
// account/app") — a driver may only ever touch their own vehicle's fuel/maintenance/route data.
async function assertOwnerOpsOrDriver(vehicle, userId) {
  const institution = await Institution.findById(vehicle.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (isOwnerOrOpsStaff(institution, userId)) return institution;
  if (vehicle.driverUser && vehicle.driverUser.toString() === userId.toString()) return institution;
  throw new AppError('You do not manage this vehicle.', 403);
}

// GET /api/institution-ops/transport/my-vehicles — the Driver Dashboard: every vehicle this
// logged-in user is the assigned driver account for.
const getMyDriverVehicles = asyncHandler(async (req, res) => {
  const vehicles = await Vehicle.find({ driverUser: req.user._id }).populate('assignedStudents', 'fullName').populate('institution', 'name');
  const rows = await Promise.all(vehicles.map(async (vehicle) => {
    const activeJourney = await TransportJourney.findOne({ vehicle: vehicle._id, status: 'in_progress' }).sort({ startedAt: -1 });
    return { ...vehicle.toObject(), activeJourney };
  }));
  return ok(res, rows);
});

// ---- Fuel Management (spec gap: "Fuel management missing") ----

const listFuelLogs = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await assertOwnerOpsOrDriver(vehicle, req.user._id);
  const logs = await FuelLog.find({ vehicle: vehicle._id }).populate('filledBy', 'fullName').sort({ date: -1 });
  return ok(res, logs);
});

const createFuelLog = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await assertOwnerOpsOrDriver(vehicle, req.user._id);
  const { date, liters, costPerLiter, odometerReading, notes } = req.body;
  if (!liters || !costPerLiter) throw new AppError('liters and costPerLiter are required.', 422);
  const log = await FuelLog.create({
    institution: vehicle.institution, vehicle: vehicle._id, date: date || new Date(),
    liters: Number(liters), costPerLiter: Number(costPerLiter), totalCost: Number(liters) * Number(costPerLiter),
    odometerReading: odometerReading || null, notes: notes || '', filledBy: req.user._id
  });
  return created(res, log, 'Fuel log recorded.');
});

// ---- Vehicle Maintenance (spec gap: "Vehicle maintenance/fitness/insurance records nahi") ----

const listMaintenanceLogs = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await assertOwnerOpsOrDriver(vehicle, req.user._id);
  const logs = await VehicleMaintenanceLog.find({ vehicle: vehicle._id }).populate('recordedBy', 'fullName').sort({ date: -1 });
  return ok(res, logs);
});

const createMaintenanceLog = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await assertOwnerOpsOrDriver(vehicle, req.user._id);
  const { type, date, description, cost, odometerReading, nextDueDate } = req.body;
  const log = await VehicleMaintenanceLog.create({
    institution: vehicle.institution, vehicle: vehicle._id, type: type || 'service', date: date || new Date(),
    description: description || '', cost: cost || 0, odometerReading: odometerReading || null,
    nextDueDate: nextDueDate || null, recordedBy: req.user._id
  });
  if (type === 'service') { vehicle.lastServiceDate = log.date; if (nextDueDate) vehicle.nextServiceDue = nextDueDate; }
  if (type === 'insurance_renewal' && nextDueDate) vehicle.insuranceExpiry = nextDueDate;
  if (type === 'fitness_renewal' && nextDueDate) vehicle.fitnessExpiry = nextDueDate;
  await vehicle.save();
  return created(res, log, 'Maintenance record added.');
});

// ======================= Inventory (15D.13) =======================

const listInventory = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const items = await InventoryItem.find({ institution: req.params.id }).populate('assignedTo', 'fullName').sort({ createdAt: -1 });
  return ok(res, items);
});

const createInventoryItem = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { name, category, quantity, location, condition, purchaseDate, purchaseCost, notes } = req.body;
  if (!name) throw new AppError('name is required.', 422);
  const item = await InventoryItem.create({
    institution: req.params.id, name, category: category || 'other', quantity: quantity ?? 1,
    location: location || '', condition: condition || 'good', purchaseDate: purchaseDate || null,
    purchaseCost: purchaseCost || 0, notes: notes || '', addedBy: req.user._id
  });
  return created(res, item, 'Item added.');
});

const updateInventoryItem = asyncHandler(async (req, res) => {
  const item = await InventoryItem.findById(req.params.itemId);
  if (!item) throw new AppError('Item not found.', 404);
  await loadInstitutionAndAssert(item.institution, req.user._id);
  const allowed = ['name', 'category', 'quantity', 'location', 'condition', 'purchaseDate', 'purchaseCost', 'assignedTo', 'notes'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) item[f] = req.body[f]; });
  await item.save();
  return ok(res, item, 'Item updated.');
});

const deleteInventoryItem = asyncHandler(async (req, res) => {
  const item = await InventoryItem.findById(req.params.itemId);
  if (!item) throw new AppError('Item not found.', 404);
  await loadInstitutionAndAssert(item.institution, req.user._id);
  await InventoryItem.deleteOne({ _id: item._id });
  return ok(res, null, 'Item removed.');
});

// ======================= Medical & Health (15D.14) =======================

const listHealthIncidents = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const incidents = await HealthIncident.find({ institution: req.params.id }).populate('student', 'fullName').sort({ occurredAt: -1 });
  return ok(res, incidents);
});

const createHealthIncident = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { student, description, actionTaken, severity, occurredAt } = req.body;
  if (!student || !description) throw new AppError('student and description are required.', 422);
  const incident = await HealthIncident.create({
    institution: req.params.id, student, description, actionTaken: actionTaken || '',
    severity: severity || 'minor', occurredAt: occurredAt || new Date(), recordedBy: req.user._id
  });

  const parentNotifications = await notifyParentsOfStudent(student, {
    title: `Health incident reported: ${incident.severity}`,
    body: description,
    sentBy: req.user._id
  }, { email: true }).catch(() => {});
  incident.parentNotified = Array.isArray(parentNotifications) && parentNotifications.length > 0;
  await incident.save();

  return created(res, incident, 'Health incident recorded.');
});

// GET/PATCH a student's static health record (bloodGroup/allergies/medicalNotes/vaccinations) —
// institution staff view, reusing StudentProfile fields already exposed on the parent/student side.
const getStudentHealthRecord = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.params.userId }).select('bloodGroup allergies medicalNotes vaccinations emergencyContact primaryInstitution');
  if (!profile) throw new AppError('Student profile not found.', 404);
  if (!profile.primaryInstitution) throw new AppError('Student is not linked to an institution.', 403);
  await loadInstitutionAndAssert(profile.primaryInstitution, req.user._id);
  return ok(res, profile);
});

const updateStudentHealthRecord = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.params.userId });
  if (!profile) throw new AppError('Student profile not found.', 404);
  if (!profile.primaryInstitution) throw new AppError('Student is not linked to an institution.', 403);
  await loadInstitutionAndAssert(profile.primaryInstitution, req.user._id);

  const { bloodGroup, allergies, medicalNotes, vaccinations, emergencyContact } = req.body;
  if (bloodGroup !== undefined) profile.bloodGroup = bloodGroup;
  if (allergies !== undefined) profile.allergies = allergies;
  if (medicalNotes !== undefined) profile.medicalNotes = medicalNotes;
  if (vaccinations !== undefined) profile.vaccinations = vaccinations;
  if (emergencyContact !== undefined) profile.emergencyContact = emergencyContact;
  await profile.save();
  return ok(res, profile, 'Health record updated.');
});

// ======================= Events & Activities (15D.17) =======================

const listEvents = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const events = await InstitutionEvent.find({ institution: req.params.id }).sort({ startDate: -1 });
  return ok(res, events);
});

// GET /api/institution-ops/:id/events/public — students/parents/teachers viewing their institution's events.
const listPublicEvents = asyncHandler(async (req, res) => {
  const events = await InstitutionEvent.find({ institution: req.params.id, status: { $ne: 'cancelled' } }).sort({ startDate: 1 });
  return ok(res, events);
});

const createEvent = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { title, type, description, startDate, endDate, venue, audience, coverImage } = req.body;
  if (!title || !startDate) throw new AppError('title and startDate are required.', 422);
  const event = await InstitutionEvent.create({
    institution: req.params.id, title, type: type || 'other', description: description || '',
    startDate, endDate: endDate || null, venue: venue || '', audience: audience || [], coverImage: coverImage || '',
    createdBy: req.user._id
  });
  return created(res, event, 'Event created.');
});

const updateEvent = asyncHandler(async (req, res) => {
  const event = await InstitutionEvent.findById(req.params.eventId);
  if (!event) throw new AppError('Event not found.', 404);
  await loadInstitutionAndAssert(event.institution, req.user._id);
  const allowed = ['title', 'type', 'description', 'startDate', 'endDate', 'venue', 'audience', 'coverImage', 'status'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) event[f] = req.body[f]; });
  await event.save();
  return ok(res, event, 'Event updated.');
});

const deleteEvent = asyncHandler(async (req, res) => {
  const event = await InstitutionEvent.findById(req.params.eventId);
  if (!event) throw new AppError('Event not found.', 404);
  await loadInstitutionAndAssert(event.institution, req.user._id);
  await InstitutionEvent.deleteOne({ _id: event._id });
  return ok(res, null, 'Event removed.');
});

const rsvpEvent = asyncHandler(async (req, res) => {
  const event = await InstitutionEvent.findById(req.params.eventId);
  if (!event) throw new AppError('Event not found.', 404);
  await assertHasRelationshipToInstitution(req.user._id, event.institution);
  if (event.rsvps.some((r) => r.user.toString() === req.user._id.toString())) throw new AppError('Already RSVP\'d.', 409);
  event.rsvps.push({ user: req.user._id });
  await event.save();
  return ok(res, event, 'RSVP recorded.');
});

// DELETE /api/institution-ops/events/:eventId/rsvp — withdraw a previous RSVP.
const cancelRsvp = asyncHandler(async (req, res) => {
  const event = await InstitutionEvent.findById(req.params.eventId);
  if (!event) throw new AppError('Event not found.', 404);
  event.rsvps = event.rsvps.filter((r) => r.user.toString() !== req.user._id.toString());
  await event.save();
  return ok(res, event, 'RSVP withdrawn.');
});

// ======================= Help Desk (15D.16) =======================

const listTickets = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const tickets = await HelpDeskTicket.find({ institution: req.params.id }).populate('raisedBy', 'fullName').populate('assignedTo', 'fullName').sort({ createdAt: -1 });
  return ok(res, tickets);
});

const myTickets = asyncHandler(async (req, res) => {
  const tickets = await HelpDeskTicket.find({ raisedBy: req.user._id }).populate('institution', 'name').sort({ createdAt: -1 });
  return ok(res, tickets);
});

const createTicket = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  await assertHasRelationshipToInstitution(req.user._id, institution._id);
  const { category, subject, description, priority } = req.body;
  if (!category || !subject || !description) throw new AppError('category, subject and description are required.', 422);

  const ticket = await HelpDeskTicket.create({
    institution: institution._id, raisedBy: req.user._id, category, subject, description, priority: priority || 'medium'
  });

  const recipients = [institution.owner, ...institution.staff.map((s) => s.user)];
  await Promise.all(recipients.map((id) => notify(id, { title: `New help desk ticket: ${ticket.ticketNumber}`, body: subject, sentBy: req.user._id }).catch(() => {})));

  return created(res, ticket, `Ticket ${ticket.ticketNumber} created.`);
});

const updateTicket = asyncHandler(async (req, res) => {
  const ticket = await HelpDeskTicket.findById(req.params.ticketId);
  if (!ticket) throw new AppError('Ticket not found.', 404);
  const institution = await loadInstitutionAndAssert(ticket.institution, req.user._id);

  const { status, priority, assignedTo, resolutionNotes } = req.body;
  if (status !== undefined) {
    ticket.status = status;
    if (status === 'resolved' || status === 'closed') ticket.resolvedAt = new Date();
  }
  if (priority !== undefined) ticket.priority = priority;
  if (assignedTo !== undefined) {
    if (assignedTo) {
      const isStaffOrOwner = institution.owner.toString() === assignedTo.toString()
        || institution.staff.some((s) => s.user.toString() === assignedTo.toString());
      if (!isStaffOrOwner) throw new AppError('A ticket can only be assigned to this institution\'s own owner/staff.', 422);
    }
    ticket.assignedTo = assignedTo || null;
  }
  if (resolutionNotes !== undefined) ticket.resolutionNotes = resolutionNotes;
  await ticket.save();

  if (status) {
    await notify(ticket.raisedBy, { title: `Ticket ${ticket.ticketNumber} — ${status}`, body: resolutionNotes || '', sentBy: req.user._id }).catch(() => {});
  }
  if (assignedTo) {
    await notify(assignedTo, { title: `Ticket assigned to you: ${ticket.ticketNumber}`, body: ticket.subject, sentBy: req.user._id }).catch(() => {});
  }
  return ok(res, ticket, 'Ticket updated.');
});

// Lazy, idempotent monthly sweep (same "no cron in this app page-read/background-timer" pattern
// as utils/feeSchedule.js) — re-generates the current month's hostel/transport Fee for every
// currently-occupied room / assigned vehicle seat, so charges keep recurring on their own
// calendar instead of only ever existing as a one-time fee created at allocation time.
async function sweepHostelTransportFees(institutionId) {
  const institution = await Institution.findById(institutionId).select('owner');
  if (!institution) return;
  const rooms = await HostelRoom.find({ institution: institutionId, 'occupants.0': { $exists: true } });
  for (const room of rooms) {
    for (const studentId of room.occupants) {
      await ensureCurrentMonthOpsFee(institutionId, studentId, 'hostel', `Hostel Fee — ${room.roomNumber}`, room.monthlyFee, room.currency, institution.owner).catch(() => {});
    }
  }
  const vehicles = await Vehicle.find({ institution: institutionId, 'assignedStudents.0': { $exists: true } });
  for (const vehicle of vehicles) {
    for (const studentId of vehicle.assignedStudents) {
      await ensureCurrentMonthOpsFee(institutionId, studentId, 'transport', `Transport Fee — ${vehicle.routeName || vehicle.vehicleNumber}`, vehicle.monthlyFee, vehicle.currency, institution.owner).catch(() => {});
    }
  }
}

module.exports = {
  listBooks, findBookByQr, listLibraryBorrowers, createBook, updateBook, deleteBook, borrowBook, returnBook, waiveLibraryFine, listLoans, getMyLibrary,
  listHostelRooms, listHostelEligibleStudents, createHostelRoom, updateHostelRoom, allocateHostelRoom, transferHostelStudent, removeHostelOccupant,
  getMyHostelStatus, createHostelRequest, listHostelRequests, decideHostelRequest,
  getWardenDashboard, markHostelAttendance, listHostelAttendance,
  listVehicles, createVehicle, updateVehicle, deleteVehicle, assignStudentToVehicle, removeStudentFromVehicle,
  getMyDriverVehicles, generateMonthlyTransportFees, listFuelLogs, createFuelLog, listMaintenanceLogs, createMaintenanceLog,
  listInventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  listHealthIncidents, createHealthIncident, getStudentHealthRecord, updateStudentHealthRecord,
  listEvents, listPublicEvents, getMyInstitutionEvents, createEvent, updateEvent, deleteEvent, rsvpEvent, cancelRsvp,
  listTickets, myTickets, createTicket, updateTicket, sweepHostelTransportFees
};
