const ClassSection = require('../models/ClassSection');
const StudentInstitutionMembership = require('../models/StudentInstitutionMembership');
const { AcademicSession, AcademicTerm, Subject } = require('../models/AcademicUnit');

// Master 15A.8: a student's membership points at their program, term, class section and that class's
// subjects. Used after admission and after promotion so the record follows the student.
async function linkToSection(membership, sectionId, programId = null) {
  const section = await ClassSection.findById(sectionId).select('institution program term session').lean();
  if (!section) return membership;
  const program = programId || section.program || membership.programRef || null;
  const term = section.term || (program ? (await AcademicTerm.findOne({ institution: section.institution, program, active: true }).sort({ order: 1 }).select('_id').lean())?._id : null) || null;
  const or = [{ classSection: sectionId }];
  if (program && term) or.push({ program, term, classSection: null });
  const subjects = (await Subject.find({ institution: section.institution, active: true, $or: or }).select('_id').lean()).map((s) => s._id);
  // Session: the class's own, else its term's, else the institution's current session.
  const session = section.session || (term ? (await AcademicTerm.findById(term).select('session').lean())?.session : null) || (await AcademicSession.findOne({ institution: section.institution, current: true }).select('_id').lean())?._id || null;
  Object.assign(membership, { programRef: program, classSection: sectionId, term, subjects, session });
  await membership.save();
  return membership;
}

async function linkStudentToSection(studentId, institutionId, sectionId) {
  const membership = await StudentInstitutionMembership.findOne({ student: studentId, institution: institutionId, status: 'active' });
  return membership ? linkToSection(membership, sectionId) : null;
}

module.exports = { linkToSection, linkStudentToSection };
