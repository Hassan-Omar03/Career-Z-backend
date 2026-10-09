const router = require('express').Router();
const ctrl = require('../controllers/institutionOps.controller');
const community = require('../controllers/eventsHelpdesk.controller');
const { protect } = require('../middleware/auth');

// Genuinely public — a prospective student should be able to see an institution's upcoming
// events (Sports Day, Open House, Convocation, etc.) without logging in first, since the whole
// point of publishing them is to attract people who aren't students yet (spec 15D.17). Must be
// registered BEFORE router.use(protect) below, or it would silently require login anyway.
router.get('/:id/events/public', community.publicEvents);

router.use(protect);
const inventory = require('../controllers/inventory.controller');
const health = require('../controllers/health.controller');
router.get('/health/teacher', health.teacher);
router.get('/:id/health-students', health.members);
router.patch('/health-incidents/:incidentId', health.followUp);
router.get('/inventory/mine', inventory.mine);
router.get('/:id/inventory-recipients', inventory.recipients);
router.get('/:id/inventory-loans', inventory.loans);
router.post('/inventory/:itemId/request', inventory.request);
router.post('/inventory/:itemId/issue', inventory.issue);
router.patch('/inventory-loans/:loanId', inventory.action);

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
router.get('/:id/inventory', inventory.list);
router.post('/:id/inventory', inventory.create);
router.patch('/inventory/:itemId', inventory.update);
router.delete('/inventory/:itemId', inventory.remove);

// Medical & Health
router.get('/:id/health-incidents', health.list);
router.post('/:id/health-incidents', health.create);
router.get('/students/:userId/health', health.record);
router.patch('/students/:userId/health', health.update);

router.get('/community/institutions', community.institutions);
router.get('/:id/ticket-recipients', community.recipients);
// Events & Activities
router.get('/mine/events', ctrl.getMyInstitutionEvents);
router.get('/:id/events', community.listEvents);
router.post('/:id/events', community.createEvent);
router.patch('/events/:eventId', community.updateEvent);
router.delete('/events/:eventId', community.deleteEvent);
router.post('/events/:eventId/rsvp', community.rsvp);
router.delete('/events/:eventId/rsvp', community.cancelRsvp);

// Help Desk
router.get('/:id/tickets', community.tickets);
router.get('/tickets/mine', community.myTickets);
router.post('/:id/tickets', community.createTicket);
router.patch('/tickets/:ticketId', community.updateTicket);

module.exports = router;
