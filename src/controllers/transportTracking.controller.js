const Vehicle = require('../models/Vehicle');
const Institution = require('../models/Institution');
const TransportJourney = require('../models/TransportJourney');
const TransportLocationPing = require('../models/TransportLocationPing');
const TransportBoardingEvent = require('../models/TransportBoardingEvent');
const StudentProfile = require('../models/StudentProfile');
const ParentChildLink = require('../models/ParentChildLink');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyMany } = require('../services/notification.service');
const { distanceMeters } = require('../utils/geo');

const GPS_STALE_MS = 5 * 60 * 1000; // no ping in 5 min while "in_progress" -> flagged stale
const NEAR_STOP_RADIUS_METERS = 300;

// Owner, or staff with the 'transport:manage' permission — same free-text permission pattern as
// 'ai:use'/'application:approve' elsewhere (spec: "Driver/staff app").
async function assertCanOperateVehicle(vehicle) {
  const institution = await Institution.findById(vehicle.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  return institution;
}
function assertStaffCanOperate(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  if (isOwner) return;
  const staffEntry = institution.staff.find((s) => s.user.toString() === userId.toString());
  if (!staffEntry || !staffEntry.permissions.includes('transport:manage')) {
    throw new AppError('You do not have permission to operate this vehicle\'s tracking.', 403);
  }
}

async function notifyParentsOfStudents(studentIds, payload) {
  if (studentIds.length === 0) return;
  const links = await ParentChildLink.find({ student: { $in: studentIds }, status: 'approved' });
  if (links.length === 0) return;
  await notifyMany(links.map((l) => l.parent), payload).catch(() => {});
}

// POST /api/transport/vehicles/:vehicleId/journeys/start
const startJourney = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.vehicleId);
  if (!vehicle) throw new AppError('Vehicle not found.', 404);
  const institution = await assertCanOperateVehicle(vehicle);
  assertStaffCanOperate(institution, req.user._id);

  const existing = await TransportJourney.findOne({ vehicle: vehicle._id, status: 'in_progress' });
  if (existing) throw new AppError('This vehicle already has a journey in progress.', 409);

  const journey = await TransportJourney.create({ vehicle: vehicle._id, institution: institution._id, startedBy: req.user._id });

  await notifyParentsOfStudents(vehicle.assignedStudents, {
    title: `${vehicle.routeName || vehicle.vehicleNumber} journey started`,
    body: 'Your child\'s vehicle is now on the road.',
    sentBy: req.user._id
  });

  return created(res, journey, 'Journey started.');
});

// PATCH /api/transport/journeys/:id/end
const endJourney = asyncHandler(async (req, res) => {
  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffCanOperate(institution, req.user._id);
  if (journey.status !== 'in_progress') throw new AppError('This journey has already ended.', 400);

  journey.status = 'completed';
  journey.endedBy = req.user._id;
  journey.endedAt = new Date();
  await journey.save();

  const vehicle = await Vehicle.findById(journey.vehicle);
  await notifyParentsOfStudents(vehicle?.assignedStudents || [], {
    title: `${vehicle?.routeName || vehicle?.vehicleNumber || 'Vehicle'} journey ended`,
    sentBy: req.user._id
  });

  return ok(res, journey, 'Journey ended.');
});

// POST /api/transport/journeys/:id/ping — manual/simulated coordinates for now (spec explicitly
// allows this as the starting mode); a real GPS device feed would call this exact same endpoint.
const postPing = asyncHandler(async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') throw new AppError('lat and lng are required numbers.', 422);

  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffCanOperate(institution, req.user._id);
  if (journey.status !== 'in_progress') throw new AppError('This journey has already ended.', 400);

  await TransportLocationPing.create({ journey: journey._id, vehicle: journey.vehicle, lat, lng });
  journey.lastPing = { lat, lng, at: new Date() };
  await journey.save();

  // Real-time push to parents of assigned children — same live-socket pattern as notifications.
  const { emitToUser } = require('../realtime/socket');
  const vehicle = await Vehicle.findById(journey.vehicle);
  if (vehicle) {
    const links = await ParentChildLink.find({ student: { $in: vehicle.assignedStudents }, status: 'approved' });
    links.forEach((l) => emitToUser(l.parent, 'transport:location', { journeyId: journey._id, lat, lng, at: journey.lastPing.at }));

    // "Near pickup/drop point" — only fires once per stop per journey.
    for (const stop of vehicle.stopPoints || []) {
      if (stop.lat == null || stop.lng == null) continue;
      if (journey.notifiedNearStops.includes(stop.name)) continue;
      if (distanceMeters(lat, lng, stop.lat, stop.lng) <= NEAR_STOP_RADIUS_METERS) {
        journey.notifiedNearStops.push(stop.name);
        await notifyParentsOfStudents(vehicle.assignedStudents, {
          title: `${vehicle.routeName || vehicle.vehicleNumber} is near ${stop.name}`,
          sentBy: req.user._id
        });
      }
    }
    await journey.save();
  }

  return ok(res, journey, 'Location updated.');
});

// POST /api/transport/journeys/:id/sos
const triggerSos = asyncHandler(async (req, res) => {
  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffCanOperate(institution, req.user._id);

  journey.sosTriggeredAt = new Date();
  await journey.save();

  const vehicle = await Vehicle.findById(journey.vehicle);
  const message = req.body.message || 'Emergency reported — please contact the institution immediately.';
  await notifyParentsOfStudents(vehicle?.assignedStudents || [], { title: `EMERGENCY — ${vehicle?.routeName || vehicle?.vehicleNumber || 'Vehicle'}`, body: message, sentBy: req.user._id });
  await notify(institution.owner, { title: `Transport SOS — ${vehicle?.vehicleNumber}`, body: message, sentBy: req.user._id }).catch(() => {});

  return ok(res, journey, 'Emergency alert sent.');
});

// POST /api/transport/journeys/:id/board — staff confirms a specific student boarding/exiting.
const staffConfirmBoarding = asyncHandler(async (req, res) => {
  const { studentId, event } = req.body;
  if (!['boarded', 'exited'].includes(event)) throw new AppError('event must be boarded or exited.', 422);

  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffCanOperate(institution, req.user._id);
  if (journey.status !== 'in_progress') throw new AppError('This journey has already ended.', 400);

  const record = await TransportBoardingEvent.create({ journey: journey._id, student: studentId, event, method: 'staff_confirm', confirmedBy: req.user._id });

  await notifyParentsOfStudents([studentId], { title: `Your child ${event} the vehicle`, sentBy: req.user._id });
  return created(res, record, `Recorded: ${event}.`);
});

// GET /api/transport/journeys/:id/qr — staff generates a short-lived boarding QR token for
// students to self-scan (same session-token pattern as attendance QR).
const getBoardingQr = asyncHandler(async (req, res) => {
  const crypto = require('crypto');
  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertStaffCanOperate(institution, req.user._id);
  if (journey.status !== 'in_progress') throw new AppError('This journey has already ended.', 400);

  journey.qrToken = crypto.randomBytes(16).toString('hex');
  journey.qrExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await journey.save();

  return ok(res, { token: journey.qrToken, expiresAt: journey.qrExpiresAt });
});

// POST /api/transport/journeys/board-by-qr — student scans the vehicle's boarding QR to
// self-confirm (spec: "Boarding/exiting QR ... se record ho").
const studentSelfBoard = asyncHandler(async (req, res) => {
  const { token, event } = req.body;
  if (!['boarded', 'exited'].includes(event)) throw new AppError('event must be boarded or exited.', 422);
  if (!token) throw new AppError('token is required.', 422);

  const journey = await TransportJourney.findOne({ qrToken: token, status: 'in_progress' });
  if (!journey || !journey.qrExpiresAt || journey.qrExpiresAt < new Date()) {
    throw new AppError('This QR code has expired — ask staff to generate a new one.', 400);
  }
  const vehicle = await Vehicle.findById(journey.vehicle);
  if (!vehicle || !vehicle.assignedStudents.some((s) => s.toString() === req.user._id.toString())) {
    throw new AppError('You are not assigned to this vehicle.', 403);
  }

  const record = await TransportBoardingEvent.create({ journey: journey._id, student: req.user._id, event, method: 'qr', confirmedBy: req.user._id });
  await notifyParentsOfStudents([req.user._id], { title: `Your child ${event} the vehicle`, sentBy: req.user._id });
  return created(res, record, `Recorded: ${event}.`);
});

// GET /api/transport/journeys/:id — status for institution staff or a parent of an assigned
// child (never for an unrelated party, and never for a journey that isn't real/active/theirs).
const getJourneyStatus = asyncHandler(async (req, res) => {
  const journey = await TransportJourney.findById(req.params.id);
  if (!journey) throw new AppError('Journey not found.', 404);
  const institution = await Institution.findById(journey.institution);
  const vehicle = await Vehicle.findById(journey.vehicle);

  const isStaff = institution && (institution.owner.toString() === req.user._id.toString()
    || institution.staff.some((s) => s.user.toString() === req.user._id.toString()));
  let isParentOfAssigned = false;
  if (!isStaff && vehicle) {
    const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' }).select('student');
    isParentOfAssigned = links.some((l) => vehicle.assignedStudents.some((s) => s.toString() === l.student.toString()));
  }
  if (!isStaff && !isParentOfAssigned) throw new AppError('You do not have access to this journey.', 403);

  const gpsStale = journey.status === 'in_progress' && (!journey.lastPing?.at || Date.now() - new Date(journey.lastPing.at).getTime() > GPS_STALE_MS);
  const delayed = journey.status === 'in_progress' && vehicle?.expectedDurationMinutes
    && (Date.now() - new Date(journey.startedAt).getTime()) / 60000 > vehicle.expectedDurationMinutes;

  const boardingEvents = await TransportBoardingEvent.find({ journey: journey._id }).populate('student', 'fullName').sort({ at: -1 });

  return ok(res, { journey, vehicle, gpsStale, delayed, boardingEvents });
});

// GET /api/transport/my-children — parent's real, scoped view: only vehicles their approved-
// linked children are actually assigned to, and only the CURRENT journey (never idle/off-duty
// location, and never an unrelated child's vehicle).
const myChildrenTransport = asyncHandler(async (req, res) => {
  const links = await ParentChildLink.find({ parent: req.user._id, status: 'approved' }).populate('student', 'fullName');
  const childIds = links.map((l) => l.student._id);

  const vehicles = await Vehicle.find({ assignedStudents: { $in: childIds } });
  const result = await Promise.all(vehicles.map(async (v) => {
    const journey = await TransportJourney.findOne({ vehicle: v._id, status: 'in_progress' }).sort({ startedAt: -1 });
    const myChildrenOnThisVehicle = links.filter((l) => v.assignedStudents.some((s) => s.toString() === l.student._id.toString())).map((l) => l.student.fullName);
    return {
      vehicle: { _id: v._id, vehicleNumber: v.vehicleNumber, routeName: v.routeName, type: v.type },
      children: myChildrenOnThisVehicle,
      activeJourney: journey ? { _id: journey._id, startedAt: journey.startedAt, lastPing: journey.lastPing } : null
    };
  }));

  return ok(res, result);
});

module.exports = {
  startJourney, endJourney, postPing, triggerSos, staffConfirmBoarding,
  getBoardingQr, studentSelfBoard, getJourneyStatus, myChildrenTransport
};
