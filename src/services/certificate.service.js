const Certificate = require('../models/Certificate');
const Institution = require('../models/Institution');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const ExamSubmission = require('../models/ExamSubmission');
const Exam = require('../models/Exam');
const Result = require('../models/Result');
const User = require('../models/User');
const { getBlockingInstitutionFee } = require('../utils/feeAccess');
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
  if (await getBlockingInstitutionFee(studentId, course.institution)) return { eligible: false, reason: 'Outstanding institution fees must be cleared.' };

  const examIds = await Exam.find({ course: course._id, published: true }).distinct('_id');
  const gradedAttempt = await ExamSubmission.findOne({ student: studentId, exam: { $in: examIds }, status: 'graded' }).populate('exam');
  if (!gradedAttempt?.exam) return { eligible: false, reason: 'At least one course exam must be completed and graded.' };
  const result = await Result.findOne({ student: studentId, course: course._id, exam: gradedAttempt.exam._id }).sort({ createdAt: -1 });
  if (!result) return { eligible: false, reason: 'A verified exam result is required.' };
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

module.exports = { courseCertificateEligibility, ensureCourseCompletionCertificate };
