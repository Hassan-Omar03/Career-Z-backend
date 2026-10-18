const QRCode = require('qrcode');
const env = require('../config/env');
const InternshipCertificate = require('../models/InternshipCertificate');
const JobApplication = require('../models/JobApplication');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify } = require('../services/notification.service');

function period(body) {
  const startDate = new Date(body.startDate), endDate = new Date(body.endDate);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) throw new AppError('Enter a valid internship start and end date.', 422);
  if (endDate > new Date()) throw new AppError('A completion certificate can only be issued after the internship has ended.', 422);
  const hours = body.hours === undefined || body.hours === '' || body.hours === null ? null : Number(body.hours);
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 5000)) throw new AppError('Hours must be between 0 and 5000.', 422);
  const skills = (Array.isArray(body.skills) ? body.skills : String(body.skills || '').split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 15);
  return { startDate, endDate, hours, skills, remarks: String(body.remarks || '').trim().slice(0, 1000) };
}
async function withQr(cert) {
  const verifyUrl = `${String(env.clientUrl).split(',')[0].trim().replace(/\/+$/, '')}/verify-certificate/${cert.verifyCode}`;
  return { ...(cert.toObject ? cert.toObject() : cert), verifyUrl, qrDataUrl: await QRCode.toDataURL(verifyUrl) };
}
async function save(doc) {
  try { return await InternshipCertificate.create(doc); }
  catch (e) { if (e.code === 11000) throw new AppError('A certificate has already been issued for this internship.', 409); throw e; }
}

// POST /api/internship-certificates/employer — { applicationId, startDate, endDate, hours, skills, remarks }
const issueAsEmployer = asyncHandler(async (req, res) => {
  const application = await JobApplication.findById(req.body.applicationId).populate('job');
  if (!application || !application.job) throw new AppError('Application not found.', 404);
  if (String(application.job.postedBy) !== String(req.user._id)) throw new AppError('Only the employer who posted this internship can issue its certificate.', 403);
  if (application.job.type !== 'internship') throw new AppError('Certificates can only be issued for internship positions.', 422);
  if (!['hired', 'completed'].includes(application.status)) throw new AppError('Only a hired intern can receive a completion certificate.', 409);
  const cert = await save({ student: application.applicant, issuerType: 'employer', issuedBy: req.user._id, job: application.job._id, application: application._id, organization: application.job.company, role: application.job.title, ...period(req.body) });
  await notify(application.applicant, { title: 'Internship certificate issued', body: `${application.job.company} issued your ${application.job.title} internship certificate.`, sentBy: req.user._id }).catch(() => {});
  return created(res, await withQr(cert), 'Internship certificate issued.');
});

// POST /api/internship-certificates/institution — placement office
// { institutionId, studentId, organization, role, startDate, endDate, hours, skills, remarks }
const issueAsInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.body.institutionId);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = String(institution.owner) === String(req.user._id);
  const isStaff = institution.staff.some((s) => String(s.user) === String(req.user._id));
  if (!isOwner && !isStaff) throw new AppError('Only this institution’s owner or staff can issue its certificates.', 403);
  if (institution.verificationStatus !== 'approved') throw new AppError('This institution must be verified before it can issue certificates.', 403);
  const studentId = req.body.studentId;
  const member = await require('../models/StudentInstitutionMembership').exists({ student: studentId, institution: institution._id })
    || await require('../models/StudentProfile').exists({ user: studentId, primaryInstitution: institution._id });
  if (!member) throw new AppError('This student is not (and was not) enrolled at your institution.', 403);
  const organization = String(req.body.organization || '').trim(), role = String(req.body.role || '').trim();
  if (!organization || !role || organization.length > 160 || role.length > 160) throw new AppError('Enter the host organization and internship role.', 422);
  const cert = await save({ student: studentId, issuerType: 'institution', issuedBy: req.user._id, institution: institution._id, organization, role, ...period(req.body) });
  await notify(studentId, { title: 'Internship certificate issued', body: `${institution.name} issued your ${role} internship certificate.`, sentBy: req.user._id }).catch(() => {});
  return created(res, await withQr(cert), 'Internship certificate issued.');
});

// GET /api/internship-certificates/mine — the student's certificates
const mine = asyncHandler(async (req, res) => {
  const rows = await InternshipCertificate.find({ student: req.user._id }).sort({ endDate: -1 });
  return ok(res, await Promise.all(rows.map(withQr)));
});

// GET /api/internship-certificates/issued — certificates this user issued
const issued = asyncHandler(async (req, res) => ok(res, await InternshipCertificate.find({ issuedBy: req.user._id }).populate('student', 'fullName email').sort({ createdAt: -1 })));

// PATCH /api/internship-certificates/:id/revoke — { reason }
const revoke = asyncHandler(async (req, res) => {
  const cert = await InternshipCertificate.findById(req.params.id);
  if (!cert) throw new AppError('Certificate not found.', 404);
  let allowed = String(cert.issuedBy) === String(req.user._id);
  if (!allowed && cert.institution) allowed = String((await Institution.findById(cert.institution).select('owner'))?.owner) === String(req.user._id);
  if (!allowed) throw new AppError('Only the issuer can revoke this certificate.', 403);
  if (cert.status === 'revoked') throw new AppError('This certificate is already revoked.', 409);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new AppError('Give a reason for revoking.', 422);
  Object.assign(cert, { status: 'revoked', revokedAt: new Date(), revokeReason: reason.slice(0, 500) });
  await cert.save();
  await notify(cert.student, { title: 'Internship certificate revoked', body: reason, sentBy: req.user._id }).catch(() => {});
  return ok(res, cert, 'Certificate revoked.');
});

module.exports = { issueAsEmployer, issueAsInstitution, mine, issued, revoke };
