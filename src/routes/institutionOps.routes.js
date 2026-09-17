const router = require('express').Router();
const ctrl = require('../controllers/institutionOps.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

// Library
router.get('/:id/books', ctrl.listBooks);
router.post('/:id/books', ctrl.createBook);
router.patch('/books/:bookId', ctrl.updateBook);
router.delete('/books/:bookId', ctrl.deleteBook);
router.post('/books/:bookId/borrow', ctrl.borrowBook);
router.patch('/loans/:loanId/return', ctrl.returnBook);
router.get('/:id/loans', ctrl.listLoans);

// Hostel
router.get('/:id/hostel-rooms', ctrl.listHostelRooms);
router.post('/:id/hostel-rooms', ctrl.createHostelRoom);
router.patch('/hostel-rooms/:roomId', ctrl.updateHostelRoom);
router.post('/hostel-rooms/:roomId/allocate', ctrl.allocateHostelRoom);
router.delete('/hostel-rooms/:roomId/occupants/:userId', ctrl.removeHostelOccupant);
router.post('/hostel-requests', ctrl.createHostelRequest);
router.get('/:id/hostel-requests', ctrl.listHostelRequests);
router.patch('/hostel-requests/:requestId', ctrl.decideHostelRequest);

// Transport
router.get('/:id/vehicles', ctrl.listVehicles);
router.post('/:id/vehicles', ctrl.createVehicle);
router.patch('/vehicles/:vehicleId', ctrl.updateVehicle);
router.delete('/vehicles/:vehicleId', ctrl.deleteVehicle);
router.post('/vehicles/:vehicleId/assign', ctrl.assignStudentToVehicle);
router.delete('/vehicles/:vehicleId/students/:userId', ctrl.removeStudentFromVehicle);

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
router.get('/:id/events', ctrl.listEvents);
router.get('/:id/events/public', ctrl.listPublicEvents);
router.post('/:id/events', ctrl.createEvent);
router.patch('/events/:eventId', ctrl.updateEvent);
router.delete('/events/:eventId', ctrl.deleteEvent);
router.post('/events/:eventId/rsvp', ctrl.rsvpEvent);

// Help Desk
router.get('/:id/tickets', ctrl.listTickets);
router.get('/tickets/mine', ctrl.myTickets);
router.post('/:id/tickets', ctrl.createTicket);
router.patch('/tickets/:ticketId', ctrl.updateTicket);

module.exports = router;
