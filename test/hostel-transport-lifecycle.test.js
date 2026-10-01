const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentInstitutionMembership = require('../src/models/StudentInstitutionMembership');
const InstitutionApplication = require('../src/models/InstitutionApplication');
const HostelRoom = require('../src/models/HostelRoom');
const HostelRequest = require('../src/models/HostelRequest');
const Vehicle = require('../src/models/Vehicle');
const Fee = require('../src/models/Fee');
const FuelLog = require('../src/models/FuelLog');
const VehicleMaintenanceLog = require('../src/models/VehicleMaintenanceLog');
const HostelAttendance = require('../src/models/HostelAttendance');
const ctrl = require('../src/controllers/institutionOps.controller');
const transportCtrl = require('../src/controllers/transportTracking.controller');

let mongo, owner, student, otherStudent, warden, driver, institution;
const models = [User, Institution, StudentInstitutionMembership, InstitutionApplication, HostelRoom, HostelRequest, Vehicle, Fee, FuelLog, VehicleMaintenanceLog, HostelAttendance];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body }, res, next)).catch(next);
  });
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  owner = await User.create({ fullName: 'Ops Owner', email: 'ops-owner@test.local', passwordHash: 'x', roles: ['institution_owner'] });
  student = await User.create({ fullName: 'Ops Student', email: 'ops-student@test.local', passwordHash: 'x', roles: ['student'] });
  otherStudent = await User.create({ fullName: 'Unrelated Student', email: 'ops-other@test.local', passwordHash: 'x', roles: ['student'] });
  warden = await User.create({ fullName: 'Room Warden', email: 'ops-warden@test.local', passwordHash: 'x', roles: ['institution_staff'] });
  driver = await User.create({ fullName: 'Bus Driver', email: 'ops-driver@test.local', passwordHash: 'x', roles: ['institution_staff'] });
  institution = await Institution.create({ name: 'Ops Institution', slug: 'ops-institution', type: 'school', country: 'PK', owner: owner._id, verificationStatus: 'approved' });
  await StudentInstitutionMembership.create({ student: student._id, institution: institution._id, status: 'active' });
  // Hostel allocation now requires the student to have opted into hostel service on an accepted
  // admission application (spec: "Hostel admission/request flow nahi" — this closes that gap).
  await InstitutionApplication.create({ institution: institution._id, applicant: student._id, program: 'Test Program', status: 'accepted', requestedServices: { hostel: true, transport: true } });
});

test('a student who is not an active member of the institution cannot be allocated a hostel room', async () => {
  const room = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000 });
  const res = await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: otherStudent._id.toString() } });
  assert.equal(res.status, 422);
});

test('allocating a hostel room generates the current month\'s hostel Fee, and a second allocation attempt is rejected as already-in-a-room', async () => {
  const roomA = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000 });
  const roomB = await HostelRoom.create({ institution: institution._id, roomNumber: '102', capacity: 2, monthlyFee: 5000 });

  const first = await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: roomA._id.toString() }, body: { student: student._id.toString() } });
  assert.equal(first.status, 200);

  const fee = await Fee.findOne({ student: student._id, feeType: 'hostel' });
  assert.ok(fee, 'a hostel Fee was created on allocation');
  assert.equal(fee.amount, 5000);

  // Student is already in room A — allocating them into room B (a second room) must be rejected.
  const second = await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: roomB._id.toString() }, body: { student: student._id.toString() } });
  assert.equal(second.status, 409);
});

test('transferring a student moves them out of their old room and into the new one, never leaving them in both', async () => {
  const roomA = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000 });
  const roomB = await HostelRoom.create({ institution: institution._id, roomNumber: '102', capacity: 2, monthlyFee: 6000 });
  await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: roomA._id.toString() }, body: { student: student._id.toString() } });

  const transfer = await invoke(ctrl.transferHostelStudent, { user: owner, params: { roomId: roomB._id.toString() }, body: { student: student._id.toString() } });
  assert.equal(transfer.status, 200);

  const freshA = await HostelRoom.findById(roomA._id);
  const freshB = await HostelRoom.findById(roomB._id);
  assert.equal(freshA.occupants.length, 0, 'no longer in the old room');
  assert.equal(freshB.occupants.length, 1, 'now in the new room');
});

test('a full hostel room refuses further allocation', async () => {
  const room = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 1, monthlyFee: 5000 });
  await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: student._id.toString() } });
  const second = await StudentInstitutionMembership.create({ student: otherStudent._id, institution: institution._id, status: 'active' });
  void second;
  await InstitutionApplication.create({ institution: institution._id, applicant: otherStudent._id, program: 'Test Program', status: 'accepted', requestedServices: { hostel: true } });
  const res = await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: otherStudent._id.toString() } });
  assert.equal(res.status, 400);
});

test('a non-member student cannot be assigned to a transport vehicle', async () => {
  const vehicle = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-1', capacity: 2, monthlyFee: 2000, addedBy: owner._id });
  const res = await invoke(ctrl.assignStudentToVehicle, { user: owner, params: { vehicleId: vehicle._id.toString() }, body: { student: otherStudent._id.toString() } });
  assert.equal(res.status, 422);
});

test('transport vehicle capacity is enforced, and a student cannot be assigned to two vehicles at once', async () => {
  const vehicleA = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-1', capacity: 1, monthlyFee: 2000, addedBy: owner._id });
  const vehicleB = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-2', capacity: 1, monthlyFee: 2500, addedBy: owner._id });

  const first = await invoke(ctrl.assignStudentToVehicle, { user: owner, params: { vehicleId: vehicleA._id.toString() }, body: { student: student._id.toString() } });
  assert.equal(first.status, 200);

  let fee = await Fee.findOne({ student: student._id, feeType: 'transport' });
  assert.equal(fee, null, 'assignment never auto-generates a transport fee before institution review');
  const generated = await invoke(ctrl.generateMonthlyTransportFees, { user: owner, params: { vehicleId: vehicleA._id.toString() }, body: { reason: 'Reviewed monthly operating cost' } });
  assert.equal(generated.status, 200);
  fee = await Fee.findOne({ student: student._id, feeType: 'transport' });
  assert.ok(fee, 'institution manual generation creates the monthly transport fee');
  assert.equal(fee.amount, 2000);
  assert.equal(fee.components[0].reason, 'Reviewed monthly operating cost');

  // Already assigned to vehicle A — assigning to vehicle B (a second vehicle) must be rejected.
  const second = await invoke(ctrl.assignStudentToVehicle, { user: owner, params: { vehicleId: vehicleB._id.toString() }, body: { student: student._id.toString() } });
  assert.equal(second.status, 409);

  // Capacity=1 vehicle, already has one student — a different student must be rejected on capacity grounds.
  await StudentInstitutionMembership.create({ student: otherStudent._id, institution: institution._id, status: 'active' });
  await InstitutionApplication.create({ institution: institution._id, applicant: otherStudent._id, program: 'Transport Program', status: 'accepted', requestedServices: { transport: true } });
  const overCapacity = await invoke(ctrl.assignStudentToVehicle, { user: owner, params: { vehicleId: vehicleA._id.toString() }, body: { student: otherStudent._id.toString() } });
  assert.equal(overCapacity.status, 400);
});

test('the monthly hostel/transport fee sweep never creates a duplicate charge for the same month', async () => {
  const room = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000 });
  await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: student._id.toString() } });

  await ctrl.sweepHostelTransportFees(institution._id);
  await ctrl.sweepHostelTransportFees(institution._id);

  const count = await Fee.countDocuments({ student: student._id, feeType: 'hostel' });
  assert.equal(count, 1, 'sweeping twice in the same month must not double-charge');
});

test('a room\'s designated warden can see it on their dashboard and decide its requests, but cannot touch an unrelated room', async () => {
  const room = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000, warden: warden._id });
  const unrelatedRoom = await HostelRoom.create({ institution: institution._id, roomNumber: '102', capacity: 2, monthlyFee: 5000 });
  await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: student._id.toString() } });

  const dashboard = await invoke(ctrl.getWardenDashboard, { user: warden });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.rooms.length, 1);
  assert.equal(dashboard.body.data.rooms[0]._id.toString(), room._id.toString());

  const request = await HostelRequest.create({ institution: institution._id, room: room._id, student: student._id, type: 'leave', fromDate: new Date(), toDate: new Date(), reason: 'Family visit' });
  const decide = await invoke(ctrl.decideHostelRequest, { user: warden, params: { requestId: request._id.toString() }, body: { decision: 'approved' } });
  assert.equal(decide.status, 200);

  const unrelatedRequest = await HostelRequest.create({ institution: institution._id, room: unrelatedRoom._id, student: student._id, type: 'visitor', visitorName: 'Uncle', visitDate: new Date() });
  const forbidden = await invoke(ctrl.decideHostelRequest, { user: warden, params: { requestId: unrelatedRequest._id.toString() }, body: { decision: 'approved' } });
  assert.equal(forbidden.status, 403, 'a warden of room 101 cannot decide requests for room 102');
});

test('hostel attendance can be bulk-marked for a room and re-marking the same date updates instead of duplicating', async () => {
  const room = await HostelRoom.create({ institution: institution._id, roomNumber: '101', capacity: 2, monthlyFee: 5000, warden: warden._id });
  await invoke(ctrl.allocateHostelRoom, { user: owner, params: { roomId: room._id.toString() }, body: { student: student._id.toString() } });

  const mark = await invoke(ctrl.markHostelAttendance, { user: warden, params: { roomId: room._id.toString() }, body: { date: '2026-09-29', entries: [{ student: student._id.toString(), status: 'present' }] } });
  assert.equal(mark.status, 200);

  const remark = await invoke(ctrl.markHostelAttendance, { user: warden, params: { roomId: room._id.toString() }, body: { date: '2026-09-29', entries: [{ student: student._id.toString(), status: 'absent' }] } });
  assert.equal(remark.status, 200);

  const count = await HostelAttendance.countDocuments({ room: room._id, student: student._id, date: '2026-09-29' });
  assert.equal(count, 1, 're-marking the same date updates the existing record instead of creating a duplicate');
  const record = await HostelAttendance.findOne({ room: room._id, student: student._id, date: '2026-09-29' });
  assert.equal(record.status, 'absent');
});

test('a vehicle\'s driver account sees it on their dashboard, can start a journey for it, but cannot operate an unrelated vehicle', async () => {
  const vehicle = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-1', capacity: 5, monthlyFee: 2000, addedBy: owner._id, driverUser: driver._id });
  const unrelatedVehicle = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-2', capacity: 5, monthlyFee: 2000, addedBy: owner._id });

  const dashboard = await invoke(ctrl.getMyDriverVehicles, { user: driver });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.length, 1);
  assert.equal(dashboard.body.data[0]._id.toString(), vehicle._id.toString());

  const start = await invoke(transportCtrl.startJourney, { user: driver, params: { vehicleId: vehicle._id.toString() }, body: {} });
  assert.equal(start.status, 201, 'the assigned driver account can start a journey for their own vehicle');

  const forbidden = await invoke(transportCtrl.startJourney, { user: driver, params: { vehicleId: unrelatedVehicle._id.toString() }, body: {} });
  assert.equal(forbidden.status, 403, 'a driver cannot operate a vehicle they are not assigned to');
});

test('fuel logs and maintenance logs can be recorded for a vehicle, and a service log updates the vehicle\'s lastServiceDate', async () => {
  const vehicle = await Vehicle.create({ institution: institution._id, vehicleNumber: 'BUS-1', capacity: 5, monthlyFee: 2000, addedBy: owner._id, driverUser: driver._id });

  const fuel = await invoke(ctrl.createFuelLog, { user: driver, params: { vehicleId: vehicle._id.toString() }, body: { liters: 40, costPerLiter: 280, odometerReading: 12000 } });
  assert.equal(fuel.status, 201);
  assert.equal(fuel.body.data.totalCost, 11200);

  const service = await invoke(ctrl.createMaintenanceLog, { user: owner, params: { vehicleId: vehicle._id.toString() }, body: { type: 'service', description: 'Oil change', cost: 3000, nextDueDate: '2026-12-01' } });
  assert.equal(service.status, 201);

  const freshVehicle = await Vehicle.findById(vehicle._id);
  assert.ok(freshVehicle.lastServiceDate, 'recording a service log updates the vehicle\'s lastServiceDate');
  assert.equal(new Date(freshVehicle.nextServiceDue).toISOString().slice(0, 10), '2026-12-01');
});
