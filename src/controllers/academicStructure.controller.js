const mongoose = require('mongoose');
const Institution = require('../models/Institution');
const { AcademicSession, Faculty, Department, AcademicTerm, Subject, SubjectGroup } = require('../models/AcademicUnit');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// Master 15A.5: the owner (or staff with settings or student-records permission) builds the academic
// structure. Every link must point at a record of the same institution (tenant isolation).
const KINDS = {
  sessions: { Model: AcademicSession, fields: ['name', 'code', 'active', 'kind', 'startDate', 'endDate', 'current'], refs: {}, users: [], children: [[AcademicTerm, 'session']] },
  faculties: { Model: Faculty, fields: ['name', 'code', 'active', 'campus', 'head'], refs: { campus: 'Campus' }, users: ['head'], children: [[Department, 'faculty']] },
  departments: { Model: Department, fields: ['name', 'code', 'active', 'faculty', 'head'], refs: { faculty: 'Faculty' }, users: ['head'], children: [[Subject, 'department']] },
  terms: { Model: AcademicTerm, fields: ['name', 'code', 'active', 'program', 'session', 'order', 'startDate', 'endDate', 'admissionStatus', 'intake', 'admissionDeadline', 'seats'], refs: { program: 'InstitutionProgram', session: 'AcademicSession', intake: 'AcademicSession' }, users: [], children: [[Subject, 'term'], [SubjectGroup, 'term']] },
  groups: { Model: SubjectGroup, fields: ['name', 'code', 'active', 'program', 'term', 'guidance', 'compulsory', 'electives', 'minElectives', 'maxElectives'], refs: { program: 'InstitutionProgram', term: 'AcademicTerm' }, lists: { compulsory: 'Subject', electives: 'Subject' }, users: [], children: [] },
  subjects: { Model: Subject, fields: ['name', 'code', 'active', 'department', 'program', 'term', 'classSection', 'teacher', 'creditHours'], refs: { department: 'Department', program: 'InstitutionProgram', term: 'AcademicTerm', classSection: 'ClassSection' }, users: ['teacher'], children: [] }
};
const MANAGE = ['settings:manage', 'students:manage'];

function kindOf(req) {
  const kind = KINDS[req.params.kind];
  if (!kind) throw new AppError('Unknown part of the academic structure.', 404);
  return kind;
}
async function access(req, manage) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Institution not found.', 404);
  const institution = await Institution.findById(req.params.id).select('owner staff verificationStatus');
  if (!institution) throw new AppError('Institution not found.', 404);
  const me = String(req.user._id);
  if (String(institution.owner) === me) return institution;
  const entry = institution.staff.find((s) => String(s.user) === me);
  if (!entry) throw new AppError('You do not manage this institution.', 403);
  if (manage && !(entry.permissions || []).some((p) => MANAGE.includes(p))) throw new AppError('You need the settings or student records permission to change the academic structure.', 403);
  return institution;
}
async function clean(kind, body, institution) {
  const out = {};
  for (const f of kind.fields) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  if (out.name !== undefined && !String(out.name || '').trim()) throw new AppError('Name is required.', 422);
  if (out.kind !== undefined && !['year', 'spring', 'fall', 'summer', 'other'].includes(out.kind)) throw new AppError('Session type must be year, spring, fall, summer or other.', 422);
  for (const d of ['startDate', 'endDate', 'admissionDeadline']) if (out[d] && Number.isNaN(new Date(out[d]).getTime())) throw new AppError('Enter a valid date.', 422);
  if (out.current !== undefined) out.current = Boolean(out.current);
  for (const [field, model] of Object.entries(kind.refs)) {
    if (!out[field]) continue;
    if (!mongoose.isValidObjectId(out[field]) || !(await mongoose.model(model).exists({ _id: out[field], institution: institution._id }))) throw new AppError(`The chosen ${field} does not belong to this institution.`, 422);
  }
  for (const [field, model] of Object.entries(kind.lists || {})) {
    if (out[field] === undefined) continue;
    const ids = [...new Set((Array.isArray(out[field]) ? out[field] : []).map(String))];
    if (ids.some((id) => !mongoose.isValidObjectId(id)) || (ids.length && (await mongoose.model(model).countDocuments({ _id: { $in: ids }, institution: institution._id })) !== ids.length)) throw new AppError(`A chosen subject does not belong to this institution.`, 422);
    out[field] = ids;
  }
  if (out.compulsory && out.electives && out.compulsory.some((id) => out.electives.includes(id))) throw new AppError('A subject cannot be both compulsory and elective in the same group.', 422);
  for (const n of ['minElectives', 'maxElectives', 'seats']) if (out[n] !== undefined && out[n] !== null) { out[n] = Number(out[n]); if (!Number.isInteger(out[n]) || out[n] < 0) throw new AppError('Enter a whole number.', 422); }
  if (out.minElectives != null && out.maxElectives != null && out.minElectives > out.maxElectives) throw new AppError('Minimum electives cannot be more than maximum.', 422);
  if (out.admissionStatus !== undefined && !['open', 'upcoming', 'closed'].includes(out.admissionStatus)) throw new AppError('Admission must be open, upcoming or closed.', 422);
  for (const field of kind.users) {
    if (!out[field]) continue;
    const id = String(out[field]);
    if (String(institution.owner) !== id && !institution.staff.some((s) => String(s.user) === id)) throw new AppError(`The chosen ${field} is not on this institution's staff.`, 422);
  }
  if (out.name !== null && out.name !== undefined) out.name = String(out.name).trim();
  return out;
}

const list = asyncHandler(async (req, res) => {
  const kind = kindOf(req);
  await access(req, false);
  const filter = { institution: req.params.id };
  for (const f of Object.keys(kind.refs)) if (req.query[f] && mongoose.isValidObjectId(req.query[f])) filter[f] = req.query[f];
  return ok(res, await kind.Model.find(filter).sort({ order: 1, name: 1 }).lean());
});

const create = asyncHandler(async (req, res) => {
  const kind = kindOf(req);
  const institution = await access(req, true);
  const data = await clean(kind, req.body || {}, institution);
  if (!data.name) throw new AppError('Name is required.', 422);
  const row = await kind.Model.create({ ...data, institution: institution._id, createdBy: req.user._id });
  if (kind.Model === AcademicSession && row.current) await AcademicSession.updateMany({ institution: institution._id, _id: { $ne: row._id } }, { $set: { current: false } });
  return created(res, row, 'Saved.');
});

const update = asyncHandler(async (req, res) => {
  const kind = kindOf(req);
  const institution = await access(req, true);
  if (!mongoose.isValidObjectId(req.params.unitId)) throw new AppError('Not found.', 404);
  const row = await kind.Model.findOneAndUpdate({ _id: req.params.unitId, institution: institution._id }, { $set: await clean(kind, req.body || {}, institution) }, { new: true, runValidators: true });
  if (!row) throw new AppError('Not found.', 404);
  if (kind.Model === AcademicSession && row.current) await AcademicSession.updateMany({ institution: institution._id, _id: { $ne: row._id } }, { $set: { current: false } });
  return ok(res, row, 'Saved.');
});

const remove = asyncHandler(async (req, res) => {
  const kind = kindOf(req);
  const institution = await access(req, true);
  if (!mongoose.isValidObjectId(req.params.unitId)) throw new AppError('Not found.', 404);
  for (const [Child, field] of kind.children) {
    if (await Child.exists({ institution: institution._id, [field]: req.params.unitId })) throw new AppError('Remove or move what is inside it first, or mark it inactive.', 409);
  }
  const row = await kind.Model.findOneAndDelete({ _id: req.params.unitId, institution: institution._id });
  if (!row) throw new AppError('Not found.', 404);
  return ok(res, null, 'Deleted.');
});

// POST /api/institutions/:id/academic/student-ids — gives a student ID to every current student who
// joined before IDs existed (migration of existing records), in the order they joined.
const backfillStudentIds = asyncHandler(async (req, res) => {
  const institution = await access(req, true);
  const Membership = require('../models/StudentInstitutionMembership');
  const { nextStudentId } = require('../utils/studentId');
  const rows = await Membership.find({ institution: institution._id, status: 'active', $or: [{ studentId: '' }, { studentId: null }, { studentId: { $exists: false } }] }).sort({ joinedAt: 1, createdAt: 1 });
  for (const m of rows) {
    m.studentId = await nextStudentId(institution._id);
    await m.save();
    await require('../models/StudentProfile').updateOne({ user: m.student, $or: [{ rollNumber: '' }, { rollNumber: null }, { rollNumber: { $exists: false } }] }, { $set: { rollNumber: m.studentId } });
  }
  return ok(res, { assigned: rows.length }, rows.length ? `${rows.length} student ID(s) given.` : 'Every current student already has an ID.');
});

module.exports = { list, create, update, remove, backfillStudentIds };
