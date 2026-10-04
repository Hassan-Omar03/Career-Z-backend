const router = require('express').Router();
const ctrl = require('../controllers/institutionOps.controller');
const { protect } = require('../middleware/auth');

// Genuinely public — a prospective student should be able to see an institution's upcoming
// events (Sports Day, Open House, Convocation, etc.) without logging in first, since the whole
// point of publishing them is to attract people who aren't students yet (spec 15D.17). Must be
// registered BEFORE router.use(protect) below, or it would silently require login anyway.
router.get('/:id/events/public', ctrl.listPublicEvents);

router.use(protect);

// Library
router.get('/:id/books', ctrl.listBooks);
router.get('/mine/library', ctrl.getMyLibrary);
router.get('/:id/library-borrowers', ctrl.listLibraryBorrowers);
router.get('/:id/books/qr/:code', ctrl.findBookByQr);
router.post('/:id/books', ctrl.createBook);
router.patch('/books/:bookId', ctrl.updateBook);
router.delete('/books/:bookId', ctrl.deleteBook);
router.post('/books/:bookId/borrow', ctrl.borrowBook);
router.patch('/loans/:loanId/return', ctrl.returnBook);
router.patch('/loans/:loanId/waive-fine', ctrl.waiveLibraryFine);
router.get('/:id/loans', ctrl.listLoans);

// Hostel
router.get('/:id/hostel-rooms', ctrl.listHostelRooms);
router.get('/:id/hostel-eligible-students', ctrl.listHostelEligibleStudents);
router.post('/:id/hostel-rooms', ctrl.createHostelRoom);
router.patch('/hostel-rooms/:roomId', ctrl.updateHostelRoom);
router.post('/hostel-rooms/:roomId/allocate', ctrl.allocateHostelRoom);
router.post('/hostel-rooms/:roomId/transfer', ctrl.transferHostelStudent);
router.delete('/hostel-rooms/:roomId/occupants/:userId', ctrl.removeHostelOccupant);
router.get('/hostel/me', ctrl.getMyHostelStatus);
router.get('/hostel/warden-dashboard', ctrl.getWardenDashboard);
router.post('/hostel-requests', ctrl.createHostelRequest);
router.get('/:id/hostel-requests', ctrl.listHostelRequests);
router.patch('/hostel-requests/:requestId', ctrl.decideHostelRequest);
router.post('/hostel-rooms/:roomId/attendance', ctrl.markHostelAttendance);
router.get('/hostel-rooms/:roomId/attendance', ctrl.listHostelAttendance);

// Transport
router.get('/:id/vehicles', ctrl.listVehicles);
router.post('/:id/vehicles', ctrl.createVehicle);
router.patch('/vehicles/:vehicleId', ctrl.updateVehicle);
router.delete('/vehicles/:vehicleId', ctrl.deleteVehicle);
router.post('/vehicles/:vehicleId/assign', ctrl.assignStudentToVehicle);
router.post('/vehicles/:vehicleId/generate-monthly-fees', ctrl.generateMonthlyTransportFees);
router.delete('/vehicles/:vehicleId/students/:userId', ctrl.removeStudentFromVehicle);
router.get('/transport/my-vehicles', ctrl.getMyDriverVehicles);
router.get('/vehicles/:vehicleId/fuel-logs', ctrl.listFuelLogs);
router.post('/vehicles/:vehicleId/fuel-logs', ctrl.createFuelLog);
router.get('/vehicles/:vehicleId/maintenance-logs', ctrl.listMaintenanceLogs);
router.post('/vehicles/:vehicleId/maintenance-logs', ctrl.createMaintenanceLog);

// Inventory
router.get('/:id/inventory', ctrl.listInventory);
router.post('/:id/inventory', ctrl.createInventoryItem);
router.patch('/inventory/:itemId', ctrl.updateInventoryItem);
router.delete('/inventory/:itemId', ctrl.deleteInventoryItem);

// Medical & Health
router.get('/:id/health-incidents', ctrl.listHealthIncidents);
router.post('/:id/health-incidents', ctrl.createHealthIncident);
router.get('/students/:userId/health', ctrl.getStudentHealthRecord);
router.patch('/students/:userId/health', ctrl.updateStudentHealthRecord);

// Events & Activities
router.get('/mine/events', ctrl.getMyInstitutionEvents);
router.get('/:id/events', ctrl.listEvents);
router.post('/:id/events', ctrl.createEvent);
router.patch('/events/:eventId', ctrl.updateEvent);
router.delete('/events/:eventId', ctrl.deleteEvent);
router.post('/events/:eventId/rsvp', ctrl.rsvpEvent);
router.delete('/events/:eventId/rsvp', ctrl.cancelRsvp);

// Help Desk
router.get('/:id/tickets', ctrl.listTickets);
router.get('/tickets/mine', ctrl.myTickets);
router.post('/:id/tickets', ctrl.createTicket);
router.patch('/tickets/:ticketId', ctrl.updateTicket);

module.exports = router;
