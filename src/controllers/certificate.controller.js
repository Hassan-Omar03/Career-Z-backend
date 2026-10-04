const QRCode = require('qrcode');
const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const InstitutionProgram = require('../models/InstitutionProgram');
const StudentProfile = require('../models/StudentProfile');
const Achievement = require('../models/Achievement');
const AcademicTranscript = require('../models/AcademicTranscript');
const { courseCertificateEligibility, ensureCourseCompletionCertificate, programCredentialEligibility, achievementCredentialEligibility, buildTranscript, issueTranscript } = require('../services/certificate.service');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
}

async function attachQrCode(certificate) {
  const verifyUrl = `${env.clientUrl}/verify-certificate/${certificate.verifyCode}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);
  const obj = certificate.toObject ? certificate.toObject() : certificate;
  return { ...obj, verifyUrl, qrDataUrl };
}

// POST /api/institutions/:id/certificates
const issueCertificate = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  if (institution.verificationStatus !== 'approved') {
    throw new AppError('This institution must be verified by Super Admin before it can issue certificates.', 403);
  }

  const { student, course, program, achievement, type = 'course' } = req.body;
  if (!student) throw new AppError('Select an eligible student.', 422);
  if (['diploma', 'training', 'degree'].includes(type)) {
    const eligibility = await programCredentialEligibility(student, program, type);
    if (!eligibility.eligible || String(eligibility.program?.institution) !== String(institution._id)) throw new AppError(eligibility.reason || 'Program does not belong to this institution.', 422);
    const certificate = await Certificate.findOneAndUpdate({ student, program, type }, { $setOnInsert: { student, institution: institution._id, program, type, title: `${type[0].toUpperCase()}${type.slice(1)} — ${eligibility.program.name}`, academicSession: eligibility.program.classSection?.academicYear || '', issuedBy: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await notify(student, { title: `${type[0].toUpperCase()}${type.slice(1)} issued`, body: `${institution.name} issued your verified ${type}. It is ready in Certificates & Transcripts.`, sentBy: req.user._id }, { email: true, ctaUrl: `${env.clientUrl}/dashboard`, ctaLabel: 'View credential' }).catch(() => {});
    return created(res, await attachQrCode(certificate), `${type} issued.`);
  }
  if (type === 'achievement') {
    const eligibility = await achievementCredentialEligibility(student, achievement, institution._id);
    if (!eligibility.eligible) throw new AppError(eligibility.reason, 422);
    const certificate = await Certificate.findOneAndUpdate({ student, achievement, type }, { $setOnInsert: { student, institution: institution._id, achievement, type, title: `Certificate of Achievement — ${eligibility.achievement.title}`, issuedBy: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await notify(student, { title: 'Achievement certificate issued', body: `${institution.name} issued your verified achievement certificate. It is ready in Certificates & Transcripts.`, sentBy: req.user._id }, { email: true, ctaUrl: `${env.clientUrl}/dashboard`, ctaLabel: 'View certificate' }).catch(() => {});
    return created(res, await attachQrCode(certificate), 'Achievement certificate issued.');
  }
  if (type !== 'course') throw new AppError('Unsupported credential type.', 422);
  if (!course) throw new AppError('Select an eligible completed course.', 422);
  const courseDoc = await Course.findOne({ _id: course, institution: institution._id });
  if (!courseDoc) throw new AppError('Course does not belong to this institution.', 422);
  const eligibility = await courseCertificateEligibility(student, course);
  if (!eligibility.eligible) throw new AppError(eligibility.reason, 422);
  const { certificate } = await ensureCourseCompletionCertificate(student, course, req.user._id);

  return created(res, await attachQrCode(certificate), 'Certificate issued.');
});

// GET /api/institutions/:id/certificates/eligible — no manual User IDs; only real completions.
const listEligibleCompletions = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const courses = await Course.find({ institution: institution._id, certificateEnabled: true }).select('title subject');
  const enrollments = await Enrollment.find({ course: { $in: courses.map((course) => course._id) }, status: 'completed', completionStatus: 'completed' }).populate('student', 'fullName email').populate('course', 'title subject');
  const rows = await Promise.all(enrollments.map(async (enrollment) => {
    const eligibility = await courseCertificateEligibility(enrollment.student._id, enrollment.course._id);
    const existing = await Certificate.findOne({ student: enrollment.student._id, course: enrollment.course._id, type: 'course' }).select('_id status');
    return { student: enrollment.student, course: enrollment.course, eligible: eligibility.eligible, reason: eligibility.reason || '', percentage: eligibility.percentage ?? null, grade: eligibility.result?.grade || '', certificate: existing };
  }));
  return ok(res, rows);
});

// GET /api/institutions/:id/certificates
const listInstitutionCertificates = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const certificates = await Certificate.find({ institution: institution._id }).populate('student', 'fullName email').populate('course', 'title subject').sort({ createdAt: -1 });
  return ok(res, certificates);
});

// GET /api/students/me/certificates
const getMyCertificates = asyncHandler(async (req, res) => {
  const certificates = await Certificate.find({ student: req.user._id, status: 'active' }).populate('student', 'fullName').populate('institution', 'name').populate('course', 'title subject').sort({ createdAt: -1 });
  const withQr = await Promise.all(certificates.map(attachQrCode));
  return ok(res, withQr);
});

// GET /api/certificates/verify/:code (public)
const verifyCertificate = asyncHandler(async (req, res) => {
  const certificate = await Certificate.findOne({ verifyCode: req.params.code })
    .populate('student', 'fullName')
    .populate('institution', 'name');
  if (!certificate) throw new AppError('Certificate not found.', 404);

  return ok(res, {
    title: certificate.title,
    studentName: certificate.student.fullName,
    institutionName: certificate.institution.name,
    issueDate: certificate.issueDate,
    status: certificate.status,
    verifyCode: certificate.verifyCode,
    academicSession: certificate.academicSession,
    finalGrade: certificate.finalGrade,
    percentage: certificate.percentage
    ,type: certificate.type
  });
});

// PATCH /api/institutions/:id/certificates/:certificateId/revoke
const revokeCertificate = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const certificate = await Certificate.findOne({ _id: req.params.certificateId, institution: institution._id });
  if (!certificate) throw new AppError('Certificate not found.', 404);
  if (certificate.status === 'revoked') return ok(res, certificate, 'Certificate already revoked.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new AppError('A revocation reason is required.', 422);
  certificate.status = 'revoked';
  certificate.revokedAt = new Date();
  certificate.revokedBy = req.user._id;
  certificate.revokeReason = reason;
  await certificate.save();
  return ok(res, certificate, 'Certificate revoked.');
});

const listAdvancedEligible = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  const [programs, profiles, achievements] = await Promise.all([
    InstitutionProgram.find({ institution: institution._id }).populate('classSection', 'academicYear'),
    StudentProfile.find({ primaryInstitution: institution._id }).populate('user', 'fullName email'),
    Achievement.find({ institution: institution._id, verificationStatus: 'verified' }).populate('student', 'fullName email')
  ]);
  const candidates = [];
  for (const profile of profiles) for (const program of programs.filter((item) => !profile.program || item.name === profile.program)) {
    for (const type of ['training', 'diploma', 'degree']) {
      const eligibility = await programCredentialEligibility(profile.user._id, program._id, type);
      candidates.push({ type, student: profile.user, program, eligible: eligibility.eligible, reason: eligibility.reason || '' });
    }
  }
  return ok(res, { programs: candidates, achievements: achievements.map((item) => ({ type: 'achievement', student: item.student, achievement: item, eligible: true })) });
});

const previewTranscript = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  try { return ok(res, await buildTranscript(req.params.studentId, institution._id)); } catch (error) { throw new AppError(error.message, 422); }
});
const createTranscript = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);
  if (institution.verificationStatus !== 'approved') throw new AppError('Institution verification is required.', 403);
  try {
    const transcript = await issueTranscript(req.body.student, institution._id, req.user._id);
    await notify(req.body.student, { title: 'Official transcript issued', body: `${institution.name} generated your official transcript. Download it from Certificates & Transcripts.`, sentBy: req.user._id }, { email: true, ctaUrl: `${env.clientUrl}/dashboard`, ctaLabel: 'View transcript' }).catch(() => {});
    return created(res, transcript, 'Verified transcript issued.');
  } catch (error) { throw new AppError(error.message, 422); }
});
const getMyTranscripts = asyncHandler(async (req, res) => {
  const rows = await AcademicTranscript.find({ student: req.user._id, status: 'active' }).populate('student', 'fullName').populate('institution', 'name').sort({ issueDate: -1 });
  return ok(res, rows);
});

module.exports = { issueCertificate, listEligibleCompletions, listAdvancedEligible, listInstitutionCertificates, getMyCertificates, verifyCertificate, revokeCertificate, previewTranscript, createTranscript, getMyTranscripts };
