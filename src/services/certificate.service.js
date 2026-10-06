const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const ExamSubmission = require('../models/ExamSubmission');
const Exam = require('../models/Exam');
const Result = require('../models/Result');
const User = require('../models/User');
const InstitutionProgram = require('../models/InstitutionProgram');
require('../models/ClassSection'); // registered for the transcript's course.classSection populate
const StudentProfile = require('../models/StudentProfile');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const Achievement = require('../models/Achievement');
const AcademicTranscript = require('../models/AcademicTranscript');
const { assertFeeAccessForCapability } = require('../utils/feeAccess');
const { notify } = require('./notification.service');

async function courseCertificateEligibility(studentId, courseId) {
  const [course, enrollment] = await Promise.all([
    Course.findById(courseId).populate('classSection', 'academicYear'),
    Enrollment.findOne({ student: studentId, course: courseId })
  ]);
  if (!course || !enrollment) return { eligible: false, reason: 'Student is not enrolled in this course.' };
  if (!course.institution) return { eligible: false, reason: 'Only an institution course can issue this certificate.' };
  const institution = await Institution.findById(course.institution);
  if (!institution || institution.verificationStatus !== 'approved') return { eligible: false, reason: 'Institution verification is required.' };
  if (!course.certificateEnabled) return { eligible: false, reason: 'Certificates are not enabled for this course.' };
  if (enrollment.completionStatus !== 'completed' || enrollment.status !== 'completed') return { eligible: false, reason: 'Course completion is not approved yet.' };
  try { await assertFeeAccessForCapability(studentId, course.institution, 'certificates'); }
  catch { return { eligible: false, reason: 'Outstanding institution fees must be cleared.' }; }

  const examIds = await Exam.find({ course: course._id, published: true }).distinct('_id');
  const gradedAttempts = await ExamSubmission.find({ student: studentId, exam: { $in: examIds }, status: 'graded' }).populate('exam');
  if (!gradedAttempts.length) return { eligible: false, reason: 'At least one course exam must be completed and graded.' };
  const result = await Result.findOne({ student: studentId, course: course._id, exam: { $in: gradedAttempts.map((attempt) => attempt.exam?._id).filter(Boolean) } }).sort({ createdAt: -1 });
  if (!result) return { eligible: false, reason: 'A verified exam result is required.' };
  const gradedAttempt = gradedAttempts.find((attempt) => String(attempt.exam?._id) === String(result.exam));
  const percentage = result.totalMarks > 0 ? Number(((result.marksObtained / result.totalMarks) * 100).toFixed(2)) : 0;
  if (percentage < Number(gradedAttempt.exam.passingPercent || 50)) return { eligible: false, reason: 'The student has not passed the required course exam.' };
  return { eligible: true, course, enrollment, institution, result, percentage };
}

async function ensureCourseCompletionCertificate(studentId, courseId, issuedBy) {
  const eligibility = await courseCertificateEligibility(studentId, courseId);
  if (!eligibility.eligible) return { certificate: null, reason: eligibility.reason };
  const { course, institution, result, percentage } = eligibility;
  const certificate = await Certificate.findOneAndUpdate(
    { student: studentId, course: course._id, type: 'course' },
    { $setOnInsert: { student: studentId, institution: institution._id, course: course._id, type: 'course', title: `Certificate of Completion — ${course.title}`, academicSession: result.academicSession || course.classSection?.academicYear || '', finalGrade: result.grade || '', percentage, issuedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const student = await User.findById(studentId).select('email');
  if (certificate.createdAt?.getTime() === certificate.updatedAt?.getTime()) await notify(studentId, { title: `Certificate issued: ${course.title}`, body: `Your verified completion certificate is ready in Certificates.`, sentBy: issuedBy }, { email: true, toAddress: student?.email }).catch(() => {});
  return { certificate, reason: '' };
}

const EXAM_TYPES = new Set(['quiz', 'midterm', 'final', 'test']);

function pointsFor(percentage) {
  if (percentage >= 85) return 4; if (percentage >= 80) return 3.7; if (percentage >= 75) return 3.3;
  if (percentage >= 70) return 3; if (percentage >= 65) return 2.7; if (percentage >= 60) return 2.3;
  if (percentage >= 55) return 2; if (percentage >= 50) return 1.7; return 0;
}
function gradeFor(percentage) {
  if (percentage >= 85) return 'A'; if (percentage >= 80) return 'A-'; if (percentage >= 75) return 'B+';
  if (percentage >= 70) return 'B'; if (percentage >= 65) return 'B-'; if (percentage >= 60) return 'C+';
  if (percentage >= 55) return 'C'; if (percentage >= 50) return 'D'; return 'F';
}

async function programCredentialEligibility(studentId, programId, type) {
  if (!['diploma', 'training', 'degree'].includes(type)) return { eligible: false, reason: 'Invalid program credential type.' };
  const program = await InstitutionProgram.findById(programId).populate('classSection', 'academicYear');
  if (!program) return { eligible: false, reason: 'Program not found.' };
  const [profile, membership, courses] = await Promise.all([
    StudentProfile.findOne({ user: studentId, primaryInstitution: program.institution }),
    StudentInstitutionMembership.findOne({ student: studentId, institution: program.institution }),
    Course.find({ institution: program.institution, classSection: program.classSection?._id || program.classSection, published: true })
  ]);
  if (!profile || !membership || !['active', 'graduated'].includes(membership.status)) return { eligible: false, reason: 'Student is not an active member of this program.' };
  if (profile.program && profile.program !== program.name) return { eligible: false, reason: 'Student is enrolled in a different program.' };
  if (!courses.length) return { eligible: false, reason: 'Program has no published courses.' };
  const enrollments = await Enrollment.find({ student: studentId, course: { $in: courses.map((c) => c._id) } });
  if (enrollments.length !== courses.length || enrollments.some((e) => e.status !== 'completed' || e.completionStatus !== 'completed')) return { eligible: false, reason: 'Every program course must be completed and approved.' };
  if (type === 'degree' && profile.status !== 'graduated' && membership.status !== 'graduated') return { eligible: false, reason: 'Student must be marked graduated before a degree can be issued.' };
  try { await assertFeeAccessForCapability(studentId, program.institution, 'certificates'); } catch { return { eligible: false, reason: 'Outstanding institution fees must be cleared.' }; }
  return { eligible: true, program, profile, courses, enrollments };
}

async function achievementCredentialEligibility(studentId, achievementId, institutionId) {
  const achievement = await Achievement.findOne({ _id: achievementId, student: studentId, institution: institutionId, verificationStatus: 'verified' });
  if (!achievement) return { eligible: false, reason: 'A verified achievement from this institution is required.' };
  try { await assertFeeAccessForCapability(studentId, institutionId, 'certificates'); } catch { return { eligible: false, reason: 'Outstanding institution fees must be cleared.' }; }
  return { eligible: true, achievement };
}

async function buildTranscript(studentId, institutionId) {
  const [profile, results] = await Promise.all([
    StudentProfile.findOne({ user: studentId, primaryInstitution: institutionId }),
    Result.find({ student: studentId, institution: institutionId }).populate({ path: 'course', select: 'title subject creditHours academicTerm classSection', populate: { path: 'classSection', select: 'academicYear' } }).sort({ academicSession: 1, term: 1, createdAt: 1 })
  ]);
  if (!profile) throw new Error('Student is not enrolled at this institution.');
  // One transcript row per course per academic session: every quiz/midterm/final/offline mark of
  // that course is pooled into it. Result.term can't key the row — offline entries put the
  // assessment name there ("Mid Term"), and older exam results stored the exam type when no term
  // was set. The semester label comes from the course's academicTerm, else an exam's own term.
  const grouped = new Map();
  results.forEach((result) => {
    if (!result.course || !(Number(result.totalMarks) > 0)) return;
    const academicSession = result.academicSession || result.course.classSection?.academicYear || '';
    const key = `${result.course._id}:${academicSession}`;
    const current = grouped.get(key) || { course: result.course._id, subject: result.subject || result.course.subject || result.course.title, term: result.course.academicTerm || '', academicSession, creditHours: Number(result.course.creditHours || 3), marksObtained: 0, totalMarks: 0 };
    if (!current.term && result.exam && result.term && !EXAM_TYPES.has(result.term)) current.term = result.term;
    current.marksObtained += Number(result.marksObtained); current.totalMarks += Number(result.totalMarks); grouped.set(key, current);
  });
  if (!grouped.size) throw new Error('No graded academic results are available.');
  const rows = [...grouped.values()].map((row) => { const percentage = Number(((row.marksObtained / row.totalMarks) * 100).toFixed(2)); return { ...row, term: row.term || 'Term not specified', percentage, grade: gradeFor(percentage), gradePoints: pointsFor(percentage) }; });
  // A semester is a term within a session — "Fall" of 2025 and "Fall" of 2026 are separate GPAs.
  const termMap = new Map(); rows.forEach((row) => { const key = `${row.academicSession}:${row.term}`; const item = termMap.get(key) || { academicSession: row.academicSession, term: row.term, credits: 0, weighted: 0 }; item.credits += row.creditHours; item.weighted += row.gradePoints * row.creditHours; termMap.set(key, item); });
  const semesterSummaries = [...termMap.values()].map((item) => ({ academicSession: item.academicSession, term: item.term, credits: item.credits, gpa: Number((item.weighted / item.credits).toFixed(2)) }));
  const totalCredits = rows.reduce((sum, row) => sum + row.creditHours, 0); const weighted = rows.reduce((sum, row) => sum + row.gradePoints * row.creditHours, 0);
  return { profile, rows, semesterSummaries, totalCredits, cgpa: Number((weighted / totalCredits).toFixed(2)) };
}

async function issueTranscript(studentId, institutionId, issuedBy) {
  try { await assertFeeAccessForCapability(studentId, institutionId, 'certificates'); } catch { throw new Error('Outstanding institution fees must be cleared.'); }
  const data = await buildTranscript(studentId, institutionId);
  return AcademicTranscript.findOneAndUpdate({ student: studentId, institution: institutionId }, { $set: { programName: data.profile.program, rollNumber: data.profile.rollNumber, rows: data.rows, semesterSummaries: data.semesterSummaries, totalCredits: data.totalCredits, cgpa: data.cgpa, status: 'active', issueDate: new Date(), issuedBy } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

module.exports = { courseCertificateEligibility, ensureCourseCompletionCertificate, programCredentialEligibility, achievementCredentialEligibility, buildTranscript, issueTranscript };
