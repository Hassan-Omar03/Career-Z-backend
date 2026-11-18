const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const InstitutionProgram = require('../models/InstitutionProgram');
const { AcademicSession, AcademicTerm, Subject, SubjectGroup } = require('../models/AcademicUnit');

// Program-based admission (client scope Point 22): each program's academic levels (grade, class or
// semester) with their admission state, intake and deadline, and each level's subject groups (e.g.
// Science / Arts) with compulsory subjects and the electives a student may choose.
const isOpen = (level, now = new Date()) => level.admissionStatus === 'open' && (!level.admissionDeadline || new Date(level.admissionDeadline) >= now);

async function optionsFor(institutionId) {
  const [programs, levels, groups, sessions] = await Promise.all([
    InstitutionProgram.find({ institution: institutionId, active: { $ne: false } }).select('name department durationTerms admissionFee totalTuitionFee currency').lean(),
    AcademicTerm.find({ institution: institutionId, active: true }).sort({ order: 1, name: 1 }).lean(),
    SubjectGroup.find({ institution: institutionId, active: true }).lean(),
    AcademicSession.find({ institution: institutionId }).select('name kind startDate endDate current').lean()
  ]);
  const subjectIds = [...new Set(groups.flatMap((g) => [...(g.compulsory || []), ...(g.electives || [])]).map(String))];
  const subjects = new Map((await Subject.find({ _id: { $in: subjectIds } }).select('name code creditHours').lean()).map((s) => [String(s._id), s]));
  const subjectView = (id) => { const s = subjects.get(String(id)); return s ? { _id: s._id, name: s.name, code: s.code || '', creditHours: s.creditHours || 0 } : null; };
  const sessionOf = new Map(sessions.map((s) => [String(s._id), s]));
  return programs.map((p) => ({
    _id: p._id, name: p.name, department: p.department, durationTerms: p.durationTerms, admissionFee: p.admissionFee, tuition: p.totalTuitionFee, currency: p.currency,
    levels: levels.filter((l) => String(l.program) === String(p._id)).map((l) => {
      const intake = l.intake ? sessionOf.get(String(l.intake)) : null;
      return {
        _id: l._id, name: l.name, order: l.order,
        admissionStatus: isOpen(l) ? 'open' : (l.admissionStatus === 'open' ? 'closed' : l.admissionStatus || 'closed'),
        admissionDeadline: l.admissionDeadline || null, seats: l.seats || null,
        intake: intake ? { _id: intake._id, name: intake.name } : null,
        groups: groups.filter((g) => String(g.term) === String(l._id)).map((g) => ({
          _id: g._id, name: g.name, guidance: g.guidance || '',
          compulsory: (g.compulsory || []).map(subjectView).filter(Boolean),
          electives: (g.electives || []).map(subjectView).filter(Boolean),
          minElectives: g.minElectives || 0, maxElectives: g.maxElectives ?? (g.electives || []).length
        }))
      };
    })
  }));
}

// Checks an applicant's choice for a program and returns what to store on the application.
// A program with no levels set up keeps the simple program-only application.
async function checkChoice(institutionId, programPlan, { term, subjectGroup, electives } = {}) {
  const levels = await AcademicTerm.find({ institution: institutionId, program: programPlan._id, active: true }).lean();
  if (!levels.length) return {};
  if (!term || !mongoose.isValidObjectId(term)) throw new AppError('Choose the class, grade or semester you are applying for.', 422);
  const level = levels.find((l) => String(l._id) === String(term));
  if (!level) throw new AppError('That class or semester is not part of this program.', 422);
  if (!isOpen(level)) throw new AppError(`Admission for ${level.name} is not open${level.admissionStatus === 'upcoming' ? ' yet' : ''}.`, 422);
  const groups = await SubjectGroup.find({ institution: institutionId, term: level._id, active: true }).lean();
  const out = { term: level._id, session: level.intake || null };
  if (!groups.length) return out;
  const group = groups.find((g) => String(g._id) === String(subjectGroup || ''));
  if (!group) throw new AppError(`Choose a subject group for ${level.name}.`, 422);
  const chosen = [...new Set((Array.isArray(electives) ? electives : []).map(String))];
  const allowed = new Set((group.electives || []).map(String));
  if (chosen.some((id) => !allowed.has(id))) throw new AppError(`One of the chosen subjects is not offered in ${group.name}.`, 422);
  const min = group.minElectives || 0, max = group.maxElectives ?? allowed.size;
  if (chosen.length < min || chosen.length > max) throw new AppError(min === max ? `Choose exactly ${min} elective subject${min === 1 ? '' : 's'} in ${group.name}.` : `Choose between ${min} and ${max} elective subjects in ${group.name}.`, 422);
  return { ...out, subjectGroup: group._id, electives: chosen, subjects: [...(group.compulsory || []).map(String), ...chosen] };
}

module.exports = { optionsFor, checkChoice, isOpen };
