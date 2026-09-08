const QRCode = require('qrcode');
const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
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

  const { student, title, course } = req.body;
  if (!student || !title) throw new AppError('student and title are required.', 422);

  const certificate = await Certificate.create({
    student,
    institution: institution._id,
    course: course || null,
    title,
    issuedBy: req.user._id
  });

  return created(res, await attachQrCode(certificate), 'Certificate issued.');
});

// GET /api/institutions/:id/certificates
const listInstitutionCertificates = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const certificates = await Certificate.find({ institution: institution._id }).populate('student', 'fullName email').sort({ createdAt: -1 });
  return ok(res, certificates);
});

// GET /api/students/me/certificates
const getMyCertificates = asyncHandler(async (req, res) => {
  const certificates = await Certificate.find({ student: req.user._id }).populate('institution', 'name').sort({ createdAt: -1 });
  const withQr = await Promise.all(certificates.map(attachQrCode));
  return ok(res, withQr);
});

// GET /api/certificates/verify/:code (public)
const verifyCertificate = asyncHandler(async (req, res) => {
  const certificate = await Certificate.findOne({ verifyCode: req.params.code })
    .populate('student', 'fullName')
    .populate('institution', 'name');
  if (!certificate) throw new AppError('Certificate not found. It may be invalid or revoked.', 404);

  return ok(res, {
    title: certificate.title,
    studentName: certificate.student.fullName,
    institutionName: certificate.institution.name,
    issueDate: certificate.issueDate
  });
});

module.exports = { issueCertificate, listInstitutionCertificates, getMyCertificates, verifyCertificate };
