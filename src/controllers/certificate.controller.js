const QRCode = require('qrcode');
const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const { courseCertificateEligibility, ensureCourseCompletionCertificate } = require('../services/certificate.service');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

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

  const { student, course } = req.body;
  if (!student || !course) throw new AppError('Select an eligible student and completed course.', 422);
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
  });
});

module.exports = { issueCertificate, listEligibleCompletions, listInstitutionCertificates, getMyCertificates, verifyCertificate };
