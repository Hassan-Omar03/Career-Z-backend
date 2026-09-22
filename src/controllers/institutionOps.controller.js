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
const InventoryItem = require('../models/InventoryItem');
const HealthIncident = require('../models/HealthIncident');
const InstitutionEvent = require('../models/InstitutionEvent');
const HelpDeskTicket = require('../models/HelpDeskTicket');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyParentsOfStudent } = require('../services/notification.service');

async function loadInstitutionAndAssert(institutionId, userId) {
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString()
    && s.permissions.some((permission) => ['institution:ops:manage', 'ops:manage'].includes(permission)));
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
  return institution;
}

// ======================= Library (15D.10) =======================

const listBooks = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const books = await LibraryBook.find({ institution: req.params.id }).sort({ title: 1 });
  return ok(res, books);
});

const createBook = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { title, author, isbn, category, copies, fileUrl, coverImage } = req.body;
  if (!title) throw new AppError('title is required.', 422);
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

// ======================= Hostel (15D.11) =======================

const listHostelRooms = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const rooms = await HostelRoom.find({ institution: req.params.id }).populate('occupants', 'fullName').populate('warden', 'fullName').sort({ roomNumber: 1 });
  return ok(res, rooms);
});

const createHostelRoom = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { building, roomNumber, floor, capacity, monthlyFee, warden } = req.body;
  if (!roomNumber || !capacity) throw new AppError('roomNumber and capacity are required.', 422);
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
  if (room.occupants.length >= room.capacity) throw new AppError('Room is full.', 400);
  if (room.occupants.some((o) => o.toString() === student)) throw new AppError('Student already allocated to this room.', 409);

  room.occupants.push(student);
  if (room.occupants.length >= room.capacity) room.status = 'full';
  await room.save();

  await notify(student, { title: `Hostel room allocated: ${room.roomNumber}`, body: room.building, sentBy: req.user._id }).catch(() => {});
  return ok(res, room, 'Student allocated.');
});

const removeHostelOccupant = asyncHandler(async (req, res) => {
  const room = await HostelRoom.findById(req.params.roomId);
  if (!room) throw new AppError('Room not found.', 404);
  await loadInstitutionAndAssert(room.institution, req.user._id);
  room.occupants = room.occupants.filter((o) => o.toString() !== req.params.userId);
  room.status = 'available';
  await room.save();
  return ok(res, room, 'Occupant removed.');
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
  const requests = await HostelRequest.find({ institution: req.params.id }).populate('student', 'fullName').populate('room', 'roomNumber').sort({ createdAt: -1 });
  return ok(res, requests);
});

const decideHostelRequest = asyncHandler(async (req, res) => {
  const request = await HostelRequest.findById(req.params.requestId);
  if (!request) throw new AppError('Request not found.', 404);
  await loadInstitutionAndAssert(request.institution, req.user._id);
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('decision must be approved or rejected.', 422);
  request.status = decision;
  request.reviewedBy = req.user._id;
  await request.save();
  await notify(request.student, { title: `Hostel ${request.type} request ${decision}`, sentBy: req.user._id }).catch(() => {});
  return ok(res, request, `Request ${decision}.`);
});

// ======================= Transport (15D.12) =======================

const listVehicles = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const vehicles = await Vehicle.find({ institution: req.params.id }).populate('assignedStudents', 'fullName').sort({ vehicleNumber: 1 });
  return ok(res, vehicles);
});

const createVehicle = asyncHandler(async (req, res) => {
  await loadInstitutionAndAssert(req.params.id, req.user._id);
  const { vehicleNumber, type, capacity, driverName, driverPhone, driverLicenseNo, routeName, stopPoints, monthlyFee } = req.body;
  if (!vehicleNumber) throw new AppError('vehicleNumber is required.', 422);
  const vehicle = await Vehicle.create({
    institution: req.params.id, vehicleNumber, type: type || 'bus', capacity: capacity || 0,
    driverName: driverName || '', driverPhone: driverPhone || '', driverLicenseNo: driverLicenseNo || '',
    routeName: routeName || '', stopPoints: stopPoints || [], monthlyFee: monthlyFee || 0, addedBy: req.user._id
  });
  return created(res, vehicle, 'Vehicle added.');
});

const updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  const allowed = ['vehicleNumber', 'type', 'capacity', 'driverName', 'driverPhone', 'driverLicenseNo', 'routeName', 'stopPoints', 'monthlyFee', 'status'];
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
  if (vehicle.assignedStudents.some((s) => s.toString() === student)) throw new AppError('Already assigned.', 409);
  vehicle.assignedStudents.push(student);
  await vehicle.save();
  await notify(student, { title: `Transport assigned: ${vehicle.vehicleNumber}`, body: vehicle.routeName, sentBy: req.user._id }).catch(() => {});
  return ok(res, vehicle, 'Student assigned.');
});

const removeStudentFromVehicle = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  await loadInstitutionAndAssert(vehicle.institution, req.user._id);
  vehicle.assignedStudents = vehicle.assignedStudents.filter((s) => s.toString() !== req.params.userId);
  await vehicle.save();
  return ok(res, vehicle, 'Student removed.');
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

  await notifyParentsOfStudent(student, {
    title: `Health incident reported: ${incident.severity}`,
    body: description,
    sentBy: req.user._id
  }, { email: true }).catch(() => {});
  incident.parentNotified = true;
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

  const { bloodGroup, allergies, medicalNotes, vaccinations } = req.body;
  if (bloodGroup !== undefined) profile.bloodGroup = bloodGroup;
  if (allergies !== undefined) profile.allergies = allergies;
  if (medicalNotes !== undefined) profile.medicalNotes = medicalNotes;
  if (vaccinations !== undefined) profile.vaccinations = vaccinations;
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
  if (event.rsvps.some((r) => r.user.toString() === req.user._id.toString())) throw new AppError('Already RSVP\'d.', 409);
  event.rsvps.push({ user: req.user._id });
  await event.save();
  return ok(res, event, 'RSVP recorded.');
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
  await loadInstitutionAndAssert(ticket.institution, req.user._id);

  const { status, priority, assignedTo, resolutionNotes } = req.body;
  if (status !== undefined) {
    ticket.status = status;
    if (status === 'resolved' || status === 'closed') ticket.resolvedAt = new Date();
  }
  if (priority !== undefined) ticket.priority = priority;
  if (assignedTo !== undefined) ticket.assignedTo = assignedTo || null;
  if (resolutionNotes !== undefined) ticket.resolutionNotes = resolutionNotes;
  await ticket.save();

  if (status) {
    await notify(ticket.raisedBy, { title: `Ticket ${ticket.ticketNumber} — ${status}`, body: resolutionNotes || '', sentBy: req.user._id }).catch(() => {});
  }
  return ok(res, ticket, 'Ticket updated.');
});

module.exports = {
  listBooks, createBook, updateBook, deleteBook, borrowBook, returnBook, listLoans,
  listHostelRooms, createHostelRoom, updateHostelRoom, allocateHostelRoom, removeHostelOccupant,
  createHostelRequest, listHostelRequests, decideHostelRequest,
  listVehicles, createVehicle, updateVehicle, deleteVehicle, assignStudentToVehicle, removeStudentFromVehicle,
  listInventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  listHealthIncidents, createHealthIncident, getStudentHealthRecord, updateStudentHealthRecord,
  listEvents, listPublicEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
  listTickets, myTickets, createTicket, updateTicket
};
