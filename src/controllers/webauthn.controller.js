const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const WebAuthnCredential = require('../models/WebAuthnCredential');
const WebAuthnChallenge = require('../models/WebAuthnChallenge');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Attendance = require('../models/Attendance');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { getRpConfig } = require('../services/webauthn.service');
const { recalculateEnrollmentProgressForCourse } = require('../utils/courseProgress');

function toUint8(str) {
  return new TextEncoder().encode(str);
}
function b64urlToBuffer(b64url) {
  return Buffer.from(b64url, 'base64url');
}

// GET /api/webauthn/register/options — "set up biometric/passkey" step 1 (one-time per device).
const getRegistrationOptions = asyncHandler(async (req, res) => {
  const { rpName, rpID } = getRpConfig();
  const existing = await WebAuthnCredential.find({ user: req.user._id });

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: toUint8(req.user._id.toString()),
    userName: req.user.email,
    userDisplayName: req.user.fullName,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required', // forces the device to actually run its biometric/PIN check
      authenticatorAttachment: 'platform' // device-built-in only — no separate USB security keys
    }
  });

  await WebAuthnChallenge.deleteMany({ user: req.user._id, purpose: 'registration' });
  await WebAuthnChallenge.create({ user: req.user._id, purpose: 'registration', challenge: options.challenge });
  return ok(res, options);
});

// POST /api/webauthn/register/verify
const verifyRegistration = asyncHandler(async (req, res) => {
  const { rpID, origin } = getRpConfig();
  const record = await WebAuthnChallenge.findOne({ user: req.user._id, purpose: 'registration' }).sort({ createdAt: -1 });
  if (!record) throw new AppError('Registration session expired — please try again.', 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: record.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID
    });
  } catch (err) {
    throw new AppError(`Biometric registration failed: ${err.message}`, 422);
  }
  await WebAuthnChallenge.deleteOne({ _id: record._id });
  if (!verification.verified || !verification.registrationInfo) throw new AppError('Biometric registration could not be verified.', 422);

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await WebAuthnCredential.create({
    user: req.user._id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: credential.transports || [],
    label: req.body.deviceLabel || 'Device biometric'
  });

  return ok(res, { registered: true }, 'Biometric/passkey registered on this device.');
});

// GET /api/webauthn/credentials/mine — so the student can see/manage what's registered.
const myCredentials = asyncHandler(async (req, res) => {
  const creds = await WebAuthnCredential.find({ user: req.user._id }).select('label deviceType createdAt');
  return ok(res, creds);
});

const removeCredential = asyncHandler(async (req, res) => {
  await WebAuthnCredential.deleteOne({ _id: req.params.id, user: req.user._id });
  return ok(res, null, 'Removed.');
});

// GET /api/webauthn/attendance/options?course=... — step 1 of marking attendance via biometric.
const getAttendanceOptions = asyncHandler(async (req, res) => {
  const { rpID } = getRpConfig();
  const credentials = await WebAuthnCredential.find({ user: req.user._id });
  if (credentials.length === 0) {
    throw new AppError('No biometric/passkey registered on this device yet — register one first, or use another attendance method.', 400);
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports }))
  });

  await WebAuthnChallenge.deleteMany({ user: req.user._id, purpose: 'authentication' });
  await WebAuthnChallenge.create({ user: req.user._id, purpose: 'authentication', challenge: options.challenge });
  return ok(res, options);
});

// POST /api/webauthn/attendance/verify — step 2: verify the assertion, then mark the student
// present the same way the QR/GPS check-ins do (one shared attendance sheet per course+day).
const verifyAttendance = asyncHandler(async (req, res) => {
  const { rpID, origin } = getRpConfig();
  const { course: courseId, date, response } = req.body;
  if (!courseId || !date || !response) throw new AppError('course, date and response are required.', 422);

  const courseDoc = await Course.findById(courseId);
  if (!courseDoc) throw new AppError('Course not found.', 404);
  const enrolled = await Enrollment.findOne({ course: courseId, student: req.user._id });
  if (!enrolled) throw new AppError('You are not enrolled in this course.', 400);

  const cred = await WebAuthnCredential.findOne({ user: req.user._id, credentialId: response.id });
  if (!cred) throw new AppError('That credential is not registered to your account.', 404);

  const record = await WebAuthnChallenge.findOne({ user: req.user._id, purpose: 'authentication' }).sort({ createdAt: -1 });
  if (!record) throw new AppError('Verification session expired — please try again.', 400);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: record.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.credentialId,
        publicKey: b64urlToBuffer(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports
      }
    });
  } catch (err) {
    throw new AppError(`Biometric verification failed: ${err.message}`, 422);
  }
  await WebAuthnChallenge.deleteOne({ _id: record._id });
  if (!verification.verified) throw new AppError('Biometric verification failed.', 422);

  cred.counter = verification.authenticationInfo.newCounter;
  await cred.save();

  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  let sheet = await Attendance.findOne({ course: courseId, date: { $gte: dayStart, $lte: dayEnd } });
  if (!sheet) {
    sheet = await Attendance.create({ course: courseId, classSection: courseDoc.classSection, date, markedBy: courseDoc.teacher, records: [] });
  }
  const already = sheet.records.find((r) => r.student.toString() === req.user._id.toString());
  if (already) return ok(res, { alreadyMarked: true }, 'You were already marked present today.');

  sheet.records.push({ student: req.user._id, status: 'present', method: 'webauthn', checkedInAt: new Date() });
  await sheet.save();
  await recalculateEnrollmentProgressForCourse(courseId).catch(() => {});

  return ok(res, { alreadyMarked: false }, 'Attendance marked via biometric verification.');
});

module.exports = {
  getRegistrationOptions, verifyRegistration, myCredentials, removeCredential,
  getAttendanceOptions, verifyAttendance
};
